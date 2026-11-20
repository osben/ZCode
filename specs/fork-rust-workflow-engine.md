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

| PR  | Scope                                                                                                                                                                                                                                                                                                          | Size (estimate)              | Gate |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---- | -------------------------------------------------------------------------------------- |
| W1  | Gate plumbing: record reads `dynamicWorkflowEnabled` and mode (`resolveDynamicWorkflowRuntimeGate` rules); policy answer stays `false` until W9; tool set defined but not registered                                                                                                                           | 300                          | off  |
| W2  | `dwf_*` repository in `node-store` with Node codecs; checksum pin for `0019`; cross-runtime goldens both ways; `session_task_link` role writer                                                                                                                                                                 | 1,500                        | off  |
| W3  | Reducer and diff port (`workflow-runs-reducer.ts`, `workflow-runs-delta.ts` and the helpers they need) with the property test; cold replay from `dwf_event`; projection hook for `workflowRuns` and the two deltas, returning the empty snapshot as today when no run exists                                   | 1,200                        | off  |
| W4  | Helper: `helper/workflow/compile` and `helper/workflow/format` (stateless, JS); Rust: compile client, sandbox spawn (`execPath`, `ELECTRON_RUN_AS_NODE=1`), entry file writer, NDJSON host (Boundary A) with a fake child for tests                                                                            | 1,800 Rust, 400 JS           | off  |
| W5a | Engine core, no I/O: identity, hash, scheduler, FIFO and hold, cap and retune, usage, events, settlement; resume replay gate; journal port used through W2                                                                                                                                                     | 4,000                        | off  |
| W5b | Engine resume and amend: import cache (`imported-cache.ts`, `dynamic-workflow-import.ts` preflight), `import-cache-closed`, `superseded`                                                                                                                                                                       | 2,000                        | off  |
| W5c | Engine holes, artifacts and reports (spec 9.6): `engine-holes.ts`, `engine-artifacts.ts` and `-primary.ts`, `engine-report.ts`, the artifact spec validator and the report tally on resume; `hole-reached`, `hole-filled`, `report`, `artifact-published`, `artifact-failed`                                   | 2,400                        | off  |
| W6a | Driver for actors: `ActorRuntime` child session, per-ask turns, `submit_result` validation budgets, repair and nudge, `escalate`, permission origin for subagents, session grants                                                                                                                              | 3,000                        | off  |
| W6b | Driver for the rest: governor (process-level, admission per attempt), model failure policy, world reads, artifact publish, stall clock, quota timer, `LiveRunGuard` and session residency                                                                                                                      | 3,000                        | off  | Status: done, parts 1 to 6 (sections 9.9 to 9.15); the gate stays off until W7 and W9. |
| W7  | The tools: `CreateWorkflow`, `AmendWorkflow`, `FillWorkflowHole`, `SaveWorkflow`, `ListSavedWorkflows`, `EvalWorkflowSnippet`, `ListWorkflowRuns`, `GetWorkflowRun`, `ResumeWorkflowRun`, `ResolveWorkflowQuestion`; window display from helper; owner exemption; child denylist; registration behind the gate | ~21,000 (re-estimated, 9.18) | off  |
| W8  | Cancel for runs in the background registry; `cancelBackgroundWork` routing; terminal, escalation, hole and stall notifications with `workflowNotification`; reminder; orphan reconciliation at session open; settings turn writer                                                                              | 1,800                        | off  |
| W9  | Hub start (`startSavedWorkflow`), `amendWorkflowRunSettings`, launch turn and provenance; policy answer driven by the gate; E2E classification and enabling (section 7.1); parent doc updates                                                                                                                  | 800 Rust, E2E                | on   |

Total: about 40,500 lines of Rust including tests and about 400 of JavaScript, estimated (22,000 before the W7 re-estimate of 9.18: 2,500 became about 21,000). Versus Node: the engine core is 6,636 TypeScript lines, the bootstrap workflow and run files about 17,290 (these include some non-engine code), and the tools 6,152. A Rust port of this size usually runs about 1.2 to 1.5 times the TypeScript for the same behaviour, so the estimate is in the expected range; it should be re-checked after W5a.

Order and dependencies: W1 and W2 can run in parallel. W3 needs W2. W4 is independent of W2 and W3. W5a needs W2. W5b needs W5a. W6a needs W5a and W4. W6b needs W6a. W7 needs W6a, W3, and W6b parts 2b, 3, 5 and 6 (added with the W7 re-estimate, 9.18). W8 needs W7. W9 needs everything.

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

- **2c-4a (built, part): the message boundary.** Node `journalAskMessageBoundary` writes the child's message count on the settled ask's node, after settlement, because the settled record replaces the row. The owner keeps each session's last settled instance (`settled`) until its next ask starts, and `set_message_boundary` writes to the active ask or to that settled one (test: `a_boundary_written_after_the_ask_settles_reaches_the_settled_ask_node`, which failed before the change). The mailbox has a `MessageBoundary` request. The workflow's turn loop sends it after a non-nudge verdict, through a defaulted `TurnRunner::message_boundary`. The runtime bridge reads the count through `ActorAgents::message_count` (`Agents::child_message_count`, the stored message count). Tests: the agents count, the workflow loop with a counting runner, and the runtime end to end. Not built in this part: `ask_mutating` has no caller yet. Its trigger is Node's `onMutating` on the child's first workspace write, which needs a hook in the child's tool execution (not scoped). The permission origin and session grants are not in this part either. **2c-4c (built): the ask stats.** Node `reportTurnObservations` reports `statsFromTurn` before each turn's end. The child counts its started tool calls in the started stream (`ChildSink::emit` on `ToolStarted`, as Node counts `ToolCallStarted`; until 2c-4f that event came before the permission check, so a refused call was counted: 2c-4f moves the start behind admission, see 9.8g), and its committed responses (`requests`). `world_tool_calls` leaves out the protocol tools (Node `isWorldTouchingToolCall`: a `session` or `userInteraction` scope). The counts sum over the ask's turns; tokens and turns are the turn's own, and a failed usage read takes Node's defaults, 0 tokens and 1 turn. The owner's `ask_stats` writes them through the engine. Tests: the counts from the stream and the protocol set (agents `child_tests`); the two-source test (the started stream shows two calls while the transcript-derived count is 0); the summed usage over two requests; the workflow loop with cumulative counts and the failed-read defaults; the runtime mapping end to end. Tokens, checked against Node: `TurnResult.usage` is `createModelUsageSummaryFromEvents` over the turn's model completions (`contracts/src/events/session.events.ts`), which is `createModelUsageSummary`: it sums `totalTokens` over every request that carries usage, and `modelRequestCount` counts those requests. A request without usage adds nothing, and a turn with none has no usage at all (the failed read). The child's `tokens` now sum the same way over the run's requests that carry usage (`RunStats::model_request`); a failed or cancelled request counts only when it reports usage, as Node counts a failed request's usage. The per-request total uses the same formula as the existing report (input, cache creation, cache read, output), which matches the SDK's `totalTokens`. `countSource` is blocked: the Rust import builder takes the count as an injected function, and the count source exists (`Agents::child_message_count`), but no production caller of `build_imported_cache` exists yet (only the golden tests). Nothing can be injected until the amend import has a caller; that wiring is the blocker, not this part. **2c-4d (built): the session grant scope.** Node's "always allow in this session" lives in memory: `PermissionService.sessionRules` (`core/src/permission/service.ts`), one service per app or per subagent run, so a restart, a cold resume or `/new` starts empty. The row's `permission` column is for group sessions (`scope = session`), not for this grant, so writing the grant there would not be Node parity. Rust matches Node: the grant is `session_grants` on the session actor (`session/src/turn_interact.rs`), with no schema change. The grant is now keyed by scope: a subagent's ask (its `origin.child_session`) is granted to that subagent only; this session's own asks use the empty scope. Before this change the set was keyed by tool name alone, so a subagent's grant answered its parent and its siblings. Tests: `a_subagent_grant_answers_only_that_subagent` (red before the change: the parent's ask was answered at once; the subagent is answered again, and the parent and a sibling still prompt; the ask carries the origin; no project rule is written), and `a_subagent_remember_still_goes_to_the_project_rules`. Known gap, as Node has it: the grant does not survive a resume.

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

### 9.8g W6a part 2c-4f: the tool-started order (as built)

Node's order, per call: the card is scheduled before hooks and the permission check (`ToolCallScheduled`, `provider-tool-rounds/cards.ts`); the call-runner runs PreToolUse and the permission check; `ToolCallStarted` follows the admission (`call-runner.ts:471`). Rust sent `ToolStarted` before admission (`query/src/executor.rs`), so a call waiting for approval showed as running and a refused call was counted as started. This part moves the start behind admission.

**Design (option i, as approved).** `QueryEvent::ToolScheduled` (and `KernelEvent::ToolScheduled`) is emitted before hooks and permission. `ToolStarted` is emitted from a `ToolStart` callback that the pipeline awaits once admission succeeds and before the call runs, so it reaches the sink before any progress. `ToolExecutor::execute` takes the callback as an `Arc<dyn ToolStart>` argument; `no_tool_start()` is the no-op for callers that observe nothing. A hidden tool, a hook refusal, a permission denial, a schema rejection and an app refusal never call it.

**Wire.** `ToolScheduled` stays internal. Its projection row is Node's scheduled row (`status: inputStreaming`), so no wire slot is added. A scheduled call that exists keeps its status and takes the call's name and input.

**Denied prompts.** `KernelEvent::InteractionResolved` gained `denied` (serde default false, skipped when false). The session sets it on a permission denial and on a withdrawn prompt. A denied prompt settles its card as `cancelled`, as Node does (`product-projection.ts`, `onPermissionResolved`), and never as running. The call's result then lands as an error, which Rust keeps as the final state. Known difference: Node's final state for a denied call is not verified here, so Rust's final state comes from the result.

**Audit: every consumer of the started and finished events.** "Before" is the tree before this part, 2c-4d (started before admission).

| Consumer                                              | Before                                                        | After                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `query/src/executor.rs`                               | emits `ToolStarted` before the pipeline                       | emits `ToolScheduled` before the pipeline; `ToolStarted` from the callback after admission                                                     |
| `tools/src/pipeline.rs`                               | no start signal                                               | awaits the callback after admit Ok, before `call`; no call on the hidden path or any `Rejection`                                               |
| `kernel-api` `DirectExecutor`                         | none                                                          | awaits the callback before running (it models an admitted call)                                                                                |
| `kernel-api` `FailingExecutor`, `compact` `DenyTools` | none                                                          | no callback (they model refusals)                                                                                                              |
| `protocol-zcode` projection                           | Started sets Running                                          | Scheduled creates the `inputStreaming` row (keeps an existing one); Started sets Running (unchanged); a denied resolution does not set Running |
| `protocol-zcode` telemetry                            | Started records the scheduled fact and counts `tool_calls`    | Scheduled records the scheduled fact; Started counts admitted calls only; a refused call finishes as a failed fact with no duration            |
| `agents` `child.rs` `RunStats`                        | Started counts every call, refused ones included              | Started counts admitted calls only (test: `a_refused_call_is_scheduled_and_finished_but_not_counted`)                                          |
| `agents` `child.rs` live activity                     | Started adds the activity; Finished removes it                | unchanged; Finished of a call that never started is a no-op (`retain`)                                                                         |
| `agents` `stall.rs`                                   | a tool joins the stall list on Started and leaves on Finished | unchanged; a permission wait is suppressed by `waiting` (see the stall note below)                                                             |
| `agents` `doing.rs`                                   | Started ignored                                               | Scheduled ignored too                                                                                                                          |
| `tui` `view/fold.rs`                                  | Started creates the running card                              | Scheduled creates a pending card (new); Started sets it running; ToolDone sets the result                                                      |
| `tui` `view/extras.rs` (activity list)                | Started adds an activity row; Finished sets its status        | Scheduled ignored; a refused call has no activity row (before: an Error row)                                                                   |
| `tui` `runner/cockpit.rs` (current line)              | Started sets the line                                         | Started sets it after admission, so the line never names a call that awaits approval                                                           |
| `tui` `view/mod.rs` elapsed time                      | start time from Started                                       | unchanged; a pending card shows no elapsed time                                                                                                |
| `protocol-zcode` `ToolDone` (projection)              | finishes a row                                                | the row exists from Scheduled, so a refused call's row finishes as an error                                                                    |

No finished event panics or underflows without a start: the stall list uses `retain`, `RunStats` counts only starts, and the projection and telemetry find their row from the scheduled event, which every call has.

**Red tests (written first, run against the tree before the change).**

- `a_denied_call_is_scheduled_but_never_starts` (`runtime/tests/interactions.rs`): red before the change, at the assertion that a call awaiting approval has not started (ToolStarted came first). Green after: the card exists before the prompt, and a denied call has no ToolStarted.
- `a_refused_call_is_scheduled_and_finished_but_not_counted` (agents `child_tests`): written after `ToolScheduled` existed. It pins the count: the refused call is not counted, the call that starts is.
- `a_refused_call_never_signals_its_start` (tools `pipeline_tests`): pins that a denial sends no start and an admitted call sends exactly one.
- `a_scheduled_call_has_its_card_before_the_prompt` (projection): a scheduled call has an `inputStreaming` card, and the prompt then makes it `pendingApproval` with the same row id. Pinned; passes once Scheduled exists.
- `a_denied_permission_does_not_turn_the_card_running` (projection): written after the fix, so it was not seen red. It pins the denial's card as `cancelled`, not running.
- The existing `a_permission_wait_pauses_the_clock_and_the_answer_restarts_it` (agents `stall_tests`) pins the stall clock during a permission wait. No new stall test was written.

**Not covered, and why.**

- Unknown tool: the MCP wait's miss path returns before the executor, so Rust emits neither a card nor a start. Node emits an error card (`call-runner.ts`, `emitToolCallError`). This predates 2c-4f and is not changed here.
- Subagent queued calls: `ChildSink::tool_scheduled` in `agents/src/child.rs` has no caller, so a subagent's live activity never lists a queued call. It was unused before this part too. Wiring it would change the subagent reminder list, so it is left for its own part.
- Stall: a permission wait of a background child is suppressed because the child sets `waiting` around the ask (`child.rs`) and the stall tick skips a waiting candidate (`stall.rs`). No end-to-end test with a background child awaiting permission exists yet.
- Hook refusal: no start (`Rejection::ByHook` returns before the callback), pinned by `a_hook_refused_call_never_signals_its_start` (tools `pipeline_hook_tests`).

**Follow-ups (not in scope of 2c-4f).** (1) The unknown-tool error card, Node's `emitToolCallError` on a registry miss. (2) Wiring `ChildSink::tool_scheduled` so a subagent's live activity lists queued calls; the helper has no caller today. (3) Child-grant eviction: a subagent's `AllowSession` grant (`GrantScope::Child`, in `session_grants`) is never removed when the child session ends. No clean hook exists: no child-close signal reaches the parent actor, so the entries live until the parent session ends. They cannot match anything later, because child session ids are not reused, so this costs memory only. (4) Durable denial record: Node persists `onPermissionDenied` (`product-projection.ts:4206`), so a cold reload replays the card as cancelled. Rust has no persisted denial: a denied call's stored result is an error, and the TUI's denied set and the projection's `denied` set are live-only, so a cold reload shows Error, and a reconnect between the denial and the rejection `ToolDone` shows Error too. Needed: a persisted denial on the tool result or the message metadata, and a `SessionView` seed for reconnect. No text match on the rejection message: `REJECT_MESSAGE` is also produced by plan mode, a declined question and cancelled calls.

**Fixtures.** Desktop and E2E fixtures: none in the Rust data files pin tool event order (checked). The Node E2E suite is unaffected. No golden changed in this part.

**Size.** 28 files, about 450 added and 40 removed lines, including tests. Under the 600-line split limit, so it is one part.

**Next.** 2c-4e (the `ask_mutating` caller) is written up as 9.8h when it lands. It rebases onto this part.

### 9.8h W6a part 2c-4e: the workspace-mutating predicate and the first-write gate (as built)

Node decides a write with `isWorkspaceMutatingToolCall` (`contracts/src/tools/contract.ts`). Its `onMutating` fires once per ask, on the first admitted call that writes (`workflow-driver-tool-activity.ts`: `reported` is local to one ask's subscription). The driver then calls `askMutating` (`workflow-driver.ts`). The owner's `ask_mutating` existed with its engine path and tests, but had no production caller until this part.

**The predicate.** `kernel-api/src/side_effect.rs` ports Node's rule: a read-only call (`Tool::is_read_only` on the admitted input) is never mutating; otherwise the scope decides, and workspace, git and system scopes are mutating. The table gives Node's scope per Rust tool name, from Node's tool handlers (`core/src/tool/handlers/*.ts`). It was regenerated from origin/fork, not from a local checkout: 11 handler files declare `session` or `userInteraction`, for 12 tool names (Agent, AskUserQuestion, escalate, EnterPlanMode, ExitPlanMode, ReadTopicResource, RespondToCoordinator, SendMessage, Skill, submit_result, TaskStop, TodoWrite). Node has no `ReadSessionContext` tool, so the table has no entry for it. A name the sources declare no scope for is listed as undeclared and is mutating, as Node treats a missing scope. A name the table does not list (MCP and plugin tools) is mutating by the same default. Tests (`tools/src/side_effect_tests.rs`): a read-only Bash call does not fire (`ls` is read-only, `rm -rf` writes); every builtin tool has a table entry; every `tool_names` constant and the three protocol literals (`submit_result`, `escalate`, `RespondToCoordinator`) have an entry (web, LSP, workflow, plan and protocol tools included).

**The trigger: the admitted start.** `query/src/executor.rs` computes `is_workspace_mutating_call(tool, input)` when it builds the start signal. After `ToolStarted`, the signal calls `RunSink::tool_mutating()`. The pipeline calls the start signal only once a call is admitted (hooks and permission passed), so a refused call (denial, hook refusal, schema refusal, hidden tool) never fires. Its test is `a_refused_call_never_signals_its_start` (tools `pipeline_tests`), which the gate depends on.

**Why a sink method and not a new `QueryEvent`.** The trigger needs the tool's own read-only classification, and `ToolStarted` carries only the name and the input (Bash classifies its command inside the tool). Adding that to `ToolStarted` would change every literal of it. A new `QueryEvent` would also need a `KernelEvent` to map to (`QueryEvent::into_kernel_event` is total), and the session journal would persist a row for every mutating call, with every exhaustive match changing. The signal is a call, not an observation: nothing records it, and only a workflow child reacts. So `RunSink::tool_mutating` is a default no-op on the trait, and `ChildSink` overrides it. If a consumer ever needs the fact on the wire, it becomes an event with one arm added then.

**The path to the owner.** `ChildSink::tool_mutating` calls the ask's `FirstMutating` gate (`agents/src/actor_turn.rs`). The gate reaches the child sink the way the submit port does: `ActorRun.on_mutating` → `LiveAgent.on_mutating` → `ChildSink::with_mutating`. The bridge's `AgentTurnRunner` makes one gate per ask, on its first turn, and the gate's notifier (`MailboxGate`, `runtime/src/actor_turns.rs`) calls `ActorHandle::mutating` on a blocking thread. That sends `ActorRequest::Mutating`, and the owner dispatches it to `ask_mutating`, which acts on the session's active ask only (Node ignores the call with no ask in flight).

**Once per ask.** `FirstMutating` swaps a flag. The runner serves every turn of one ask, so a nudged turn does not fire again; a new ask gets a new runner, so it fires again (Node's `reported` is local to each ask's subscription). The engine's import-cache close stays once per run, as Node's cache closes once per run; the per-ask rule lives in the bridge.

**Tests.** The red runs were recorded before the code they test existed:

- agents `mutating_tests`: a nudged turn of the same ask does not fire again; a new ask fires again. Red: the gate did not exist (compile).
- runtime `actor_turns_tests::a_mutating_call_of_an_ask_reaches_the_owner_through_the_bridge`: a scripted turn calls its gate, and the owner's run records one `import-cache-closed`. Red: compile, then no event before the bridge carried the gate.
- tools `side_effect_tests`: the read-only Bash case and the completeness tests above.
  Green after the wiring; the touched crates' lib tests pass.

**Follow-ups (not in scope of 2c-4e).**

1. The owner's `settled` map stays for ask stats (2c-4c, `ask_instance`). The boundary no longer uses it. Removing the map is a separate cleanup: the stats path would need the instance carried the same way the boundary carries it.
2. The unknown-tool error card (Node `emitToolCallError` on a registry miss).
3. Wiring `ChildSink::tool_scheduled`, which has no caller, so a subagent's live activity lists no queued calls.
4. Production construction of `AgentTurnRunner` (one runner per ask) is not wired; the gate's per-ask rule relies on it.
5. The completeness test covers the builtin registry and the known constants. A tool outside them takes the default (mutating), by design.
6. Rust-only tools with no Node counterpart default to mutating, and that closes the import cache needlessly. They are ListAgents, the Task\* tools (TaskCreate, TaskGet, TaskList, TaskUpdate), Monitor and ScheduleWakeup. origin/fork declares no tool with these names, so the table lists them as undeclared. They need their own classification: a read-only one should be read-only, and a write should say which scope it writes.

### 9.8i W6a part 2c-4b: the Node driver tests (as built)

Scope. The Node cases that need a session or the driver's ask path: `bootstrap/tests/workflow-driver.test.ts` (36 cases), `workflow-driver-submit-profile.test.ts` (7), `workflow-escalation.test.ts` (19), and the escalation block of `dynamic-workflow-run-service.test.ts` (`升级问答`, 5 cases, and the end-to-end escalation block, 2 cases). Not inventoried, out of scope for this part: the artifact, ask-progress, quiescence and git-grep driver tests. Concurrency and the seat gate are W6b.

Ported tests: `crates/workflow/src/driver_node_parity_tests.rs` (wired in `lib.rs`). They run the owner's real submit, turn-end, escalation and session-id paths on the `Recording` double of `driver_owner_tests`. `owner`, `running_ask`, `request` and `Recording` are reused, not edited. The turn runtime is not involved; the runtime-level tests (`actor_turns_tests`) already cover the bridge.

Counts: 69 cases. Ported: 16, all passing (row 15 was the resume identity gap, fixed in 4e5bfec98; rows 31-36, the session close chain, are ported in W6b part 6, section 9.15). Covered by a named Rust test: 35. W6b: 1 (world reads, row 11, moved here by review, part 4). Owned by a later part or wave: 17 (W5b seed copy, 5; W6a follow-up, 1; W3 projection, 2; W7 tools and registry, 8; W8 cancel, 1). Truly not applicable: 0. Total 69 (16 + 35 + 1 + 17).

Translation of Node's model-level assertions. Node counts model requests and reads the prompt that reaches the model. The Rust owner has no model: it sees turn starts (`Recording.inputs`, `submit_schemas`, `interactions`) and reply sequences. A repair that Node sees as two requests in one turn is, in Rust, a second `submit_result` on the same turn. A nudge is a `TurnEndReply::Verdict(Nudge)`, and the nudged turn's text is built by the turn runner (`workflow` `actor_turns.rs`), so it is checked there. Node's `epilogueStart` on the persisted message is checked in Rust as the run's `epilogue_start` (runtime `a_scripted_actor_turn_runs_through_the_workflow_and_settles_after_the_nudge`); the persisted metadata is not asserted in Rust.

| #   | Node file              | Node case (short)                                                                                  | Class           | Where / reason                                                                                                                                                                                                                                                                   |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | workflow-driver        | accept path: a valid submit settles and returns the artifact                                       | covered         | `driver_owner::a_valid_submit_settles_the_ask_and_the_session_has_no_ask_afterwards`; runtime `a_submitted_result_is_accepted_through_the_mailbox_and_settles_the_ask`                                                                                                           |
| 2   | workflow-driver        | in-session repair: invalid, retry in the turn, accept                                              | covered         | `driver_owner::an_invalid_submit_is_rejected_with_its_violations_and_the_ask_stays_live`, `a_rejected_submit_keeps_the_ask_live_so_a_turn_end_is_nudged`                                                                                                                         |
| 3   | workflow-driver        | repair exhausted: ValidationFailed                                                                 | covered         | `driver_owner::an_exhausted_repair_budget_answers_the_submit_as_the_engine_cancelled_it_and_fails_the_ask`                                                                                                                                                                       |
| 4   | workflow-driver        | nudge a turn with no submit, accept on the fresh turn                                              | covered         | runtime `a_scripted_actor_turn_runs_through_the_workflow_and_settles_after_the_nudge`; `driver_owner::a_turn_that_ends_without_a_submit_is_nudged_once_then_fails_with_result_not_submitted`                                                                                     |
| 5   | workflow-driver        | nudge exhausted: ResultNotSubmitted                                                                | covered         | `driver_owner::a_turn_that_ends_without_a_submit_is_nudged_once_then_fails_with_result_not_submitted`                                                                                                                                                                            |
| 6   | workflow-driver        | untyped ask settles from the turn's final text                                                     | covered         | `driver_owner::a_turn_end_on_an_untyped_ask_settles_it_with_its_text`                                                                                                                                                                                                            |
| 7   | workflow-driver        | submit_result on an untyped ask is answered, no hang                                               | covered         | `driver_owner::a_submit_on_an_untyped_ask_is_refused_at_the_port`                                                                                                                                                                                                                |
| 8   | workflow-driver        | lenient: a stringified object is accepted, the journal holds the object                            | ported          | `a_stringified_submit_is_accepted_and_journaled_as_the_parsed_object` (passes; `scheduler_submit::normalize_submit` already does this)                                                                                                                                           |
| 9   | workflow-driver        | actor tool surface keeps the working set, drops question, plan and meta tools                      | covered         | agents `live_actor_tests::an_actor_is_denied_the_tools_node_denies_its_subagents` (the deny list; the model's tool names are not seen at the owner)                                                                                                                              |
| 10  | workflow-driver        | resume by replay: journaled nodes short-circuit, zero dispatches                                   | covered         | `scheduler_golden_tests` replays Node-generated `scheduler-goldens.json`, which has `cached` settles                                                                                                                                                                             |
| 11  | workflow-driver        | world reads: glob and read through the fs port feed a typed ask                                    | W6b part 4      | Ported in W6b part 4 (section 9.11): the read, fault and panic cases through the owner (`world_wiring_tests.rs`), and the pure and execution halves with fakes. The result feeding a typed ask is not re-tested here.                                                            |
| 12  | workflow-driver        | session id contains the run id and no `# @ /`                                                      | ported          | `a_session_id_carries_the_run_id_and_no_separator`                                                                                                                                                                                                                               |
| 13  | workflow-driver        | `a_b` and `a#b` do not collapse (underscore escape)                                                | ported          | `an_underscore_in_a_run_id_does_not_collide_with_a_hash`                                                                                                                                                                                                                         |
| 14  | workflow-driver        | adversarial pairs (`actor#1` / `actor_1`, ...) do not collide                                      | ported          | `adversarial_name_pairs_mint_distinct_charset_safe_ids`                                                                                                                                                                                                                          |
| 15  | workflow-driver        | resume: a journal session id that is not the minted one fails before the factory                   | ported, ignored | `a_journal_session_id_that_is_not_the_minted_one_fails_before_a_session_is_created` (`#[ignore]`, red; see the gap below)                                                                                                                                                        |
| 16  | workflow-driver        | resume: a matching journal session id reattaches the same id                                       | covered         | `actor_sessions_tests::the_session_id_is_the_replay_envelope_id_for_the_actor`                                                                                                                                                                                                   |
| 17  | workflow-driver        | a new actor with no journal record creates its session                                             | covered         | `driver_owner::an_actor_session_carries_the_node_title_parent_and_link_path`                                                                                                                                                                                                     |
| 18  | workflow-driver        | each settled ask writes its session's message count; the second is larger                          | covered         | runtime `a_settled_ask_writes_the_child_message_count_as_its_boundary` (the count; growth across asks is not asserted in Rust)                                                                                                                                                   |
| 19  | workflow-driver        | boundaries of two actors count their own sessions                                                  | covered         | `driver_owner::a_message_boundary_is_written_to_its_instance_and_no_other_node`                                                                                                                                                                                                  |
| 20  | workflow-driver        | no transcript store: no boundary is written                                                        | ported          | `an_ask_with_no_reported_boundary_keeps_none`                                                                                                                                                                                                                                    |
| 21  | workflow-driver        | seed: the prefix of the source session is copied, source untouched                                 | W5b             | Seed copy (amend-resume transcript truncation, Node `ensureSession` seed). Owner W5b, the amend import: needs a transcript-copy port and a production caller of `build_imported_cache` (countSource). The seed is dropped at the driver (`_seed`) until then.                    |
| 22  | workflow-driver        | seed: the copied transcript reaches the first model request                                        | W5b             | Seed copy: the copied transcript reaches the first model request. Owner W5b (as row 21).                                                                                                                                                                                         |
| 23  | workflow-driver        | seed: idempotent when the target already has content                                               | W5b             | Seed copy: idempotent when the target already has content. Owner W5b (as row 21).                                                                                                                                                                                                |
| 24  | workflow-driver        | seed: a missing or short source fails structured                                                   | W5b             | Seed copy: a missing or short source fails structured. Owner W5b (as row 21).                                                                                                                                                                                                    |
| 25  | workflow-driver        | no seed: a fresh empty session                                                                     | W5b             | No seed: a fresh empty session. The empty-transcript check needs the transcript store the W5b amend import reads. Owner W5b (as row 21).                                                                                                                                         |
| 26  | workflow-driver        | typed ask input: instructions, standard, schema epilogue, in that order                            | covered         | `driver_owner::a_typed_turn_starts_with_its_composed_input_and_the_boundary_at_the_instructions_end`                                                                                                                                                                             |
| 27  | workflow-driver        | untyped ask input: instructions then the standard, no schema epilogue                              | ported          | `an_untyped_ask_input_is_the_instructions_then_the_standard_only`                                                                                                                                                                                                                |
| 28  | workflow-driver        | a schema declaring `evidence` and `confidence` adds their two lines                                | ported          | `a_schema_declaring_evidence_and_confidence_gets_their_standard_lines`                                                                                                                                                                                                           |
| 29  | workflow-driver        | nudge prompt carries no epilogue; inputHash is the original                                        | covered         | workflow `actor_turns_tests::a_turn_without_a_submit_is_nudged_and_the_nudged_turn_runs_with_the_nudge_prompt` (the text, epilogue start 0); the hash is in `driver_golden_tests`                                                                                                |
| 30  | workflow-driver        | the epilogue start is marked on the persisted user message                                         | covered         | runtime `a_scripted_actor_turn_runs_through_the_workflow_and_settles_after_the_nudge` (the run's `epilogue_start`); the persisted metadata is not asserted in Rust                                                                                                               |
| 31  | workflow-driver        | dispose: an idle session is closed at once                                                         | ported          | Ported (9.15). `driver_close_tests::row_31_an_idle_session_is_closed_at_once_when_the_run_settles`; turn side `actor_turns_close_tests::row_31_turn_side_an_idle_session_is_closed_at_once`.                                                                                     |
| 32  | workflow-driver        | dispose: a session with an in-flight turn waits for it to land                                     | ported          | Ported (9.15). Owner `driver_close_tests::row_32_a_session_with_a_turn_in_flight_is_handed_to_the_close_port_after_its_cancel`; the wait is on the turn side, `actor_turns_close_tests::row_32_turn_side_a_session_closed_mid_turn_is_closed_when_the_turn_lands`.               |
| 33  | workflow-driver        | dispose during creation: a late instance is closed and nothing new is accepted                     | ported          | Ported as a refusal (9.15, divergence 77). `driver_close_tests::row_33_a_disposed_driver_refuses_a_session_and_creates_nothing`. A late instance cannot exist in Rust.                                                                                                           |
| 34  | workflow-driver        | dispose twice closes each runtime once                                                             | ported          | Ported (9.15). `driver_close_tests::row_34_disposing_twice_closes_each_session_once`; turn side `actor_turns_close_tests::row_34_turn_side_two_close_requests_close_the_session_once`.                                                                                           |
| 35  | workflow-driver        | a failed close only warns; settlement does not throw                                               | ported          | Ported (9.15). `driver_close_tests::row_35_a_failed_close_is_recorded_and_the_settlement_does_not_throw`; turn side `actor_turns_close_tests::row_35_turn_side_a_refused_idle_close_is_returned_to_the_caller`.                                                                  |
| 36  | workflow-driver        | real pipeline: each runtime closed exactly once; GC collectable                                    | ported          | Ported, GC half not carried (9.15, divergence 47). `driver_close_tests::row_36_the_pipeline_closes_each_actor_session_exactly_once`.                                                                                                                                             |
| 37  | submit-profile         | mono: `{ result: schema }` declared, strict, epilogue shrinks                                      | covered         | `driver_owner::a_mono_turn_carries_its_submit_schema_and_a_generic_turn_carries_none`; `driver_owner::a_mono_profile_that_fits_the_ask_ends_its_input_with_the_tool_epilogue`; agents `submit_tests::a_mono_session_declares_its_schema_under_result_and_a_generic_one_does_not` |
| 38  | submit-profile         | mono still repairs in-session against the validator                                                | covered         | `driver_owner::an_invalid_submit_is_rejected_with_its_violations_and_the_ask_stays_live`; runtime `a_mono_session_hands_its_submit_schema_to_every_turn_of_its_ask`                                                                                                              |
| 39  | submit-profile         | two result types: generic tool, full schema epilogue                                               | covered         | `driver_owner::a_mono_profile_that_misses_falls_back_to_generic_and_the_input_carries_the_schema_epilogue`                                                                                                                                                                       |
| 40  | submit-profile         | untyped-only subagent: no submit_result at all                                                     | ported          | `an_untyped_profile_declares_no_submit_schema_on_its_turn`                                                                                                                                                                                                                       |
| 41  | submit-profile         | no profile map: every subagent is generic                                                          | covered         | `driver_owner::a_mono_turn_carries_its_submit_schema_and_a_generic_turn_carries_none`                                                                                                                                                                                            |
| 42  | submit-profile         | runtime guard: a mono declaration that misses falls back to generic                                | covered         | `driver_owner::a_mono_profile_that_misses_the_ask_falls_back_and_the_ask_still_runs`                                                                                                                                                                                             |
| 43  | submit-profile         | runtime guard: a typed ask on an untyped subagent fails loudly, no turn starts                     | covered         | `driver_owner::an_untyped_profile_on_a_typed_ask_fails_the_ask_with_the_driver_error`                                                                                                                                                                                            |
| 44  | workflow-escalation    | a parked question answered: the answer is the escalate result                                      | covered         | `driver_owner::an_accepted_answer_is_delivered_to_the_blocked_escalate_on_its_session`; runtime `a_blocked_escalation_is_answered_through_the_mailbox_and_returns_the_answer`                                                                                                    |
| 45  | workflow-escalation    | askedAt is the moment of the question, shared by the event and the record                          | covered         | `escalation_tests::the_raised_event_carries_the_node_fields_in_node_order`                                                                                                                                                                                                       |
| 46  | workflow-escalation    | context is parked; blank context counts as absent                                                  | covered         | `driver_golden_tests::escalation_context_and_actor_name_normalise_as_node_does` (normaliser golden)                                                                                                                                                                              |
| 47  | workflow-escalation    | at most 3 parks per ask; the 4th is an ordinary refusal                                            | covered         | `escalation_tests::a_fourth_escalation_in_one_ask_is_an_ordinary_refusal_and_never_parks`                                                                                                                                                                                        |
| 48  | workflow-escalation    | budget resets per ask; a new ask withdraws the old parks                                           | covered         | `escalation_tests::a_new_ask_withdraws_parked_questions_and_resets_the_budget`                                                                                                                                                                                                   |
| 49  | workflow-escalation    | a named actor reaches the record and the raised event                                              | covered         | `driver_owner::an_escalation_is_journaled_under_the_session_actor_and_persona_whatever_the_caller_sent`                                                                                                                                                                          |
| 50  | workflow-escalation    | anonymous actor: the name field is absent                                                          | covered         | `driver_golden_tests::escalation_context_and_actor_name_normalise_as_node_does` (effective-name golden)                                                                                                                                                                          |
| 51  | workflow-escalation    | empty-string name counts as anonymous                                                              | covered         | as 50                                                                                                                                                                                                                                                                            |
| 52  | workflow-escalation    | whitespace-only name is not trimmed to anonymous                                                   | covered         | as 50 (JavaScript `trim` golden)                                                                                                                                                                                                                                                 |
| 53  | workflow-escalation    | cancelAsk rejects the parked deferred; a later answer finds no run                                 | covered         | `driver_owner::completing_the_run_cancels_the_in_flight_turn_and_withdraws_its_questions`; the refusal code `run_not_in_flight` is service-level (W7)                                                                                                                            |
| 54  | workflow-escalation    | cancelAsk rejects every parked item of the session                                                 | covered         | `escalation_tests::ending_an_ask_withdraws_its_questions_and_refuses_later_answers`                                                                                                                                                                                              |
| 55  | workflow-escalation    | two runs on one table: qids do not collide                                                         | W7              | Two runs on one escalation table. The shared table is the `ResolveWorkflowQuestion` registry (W7). The Rust book is per run.                                                                                                                                                     |
| 56  | workflow-escalation    | seq is monotonic within a run                                                                      | W6a follow-up   | Seq is monotonic within a run. The sequence is internal to the book; a direct test is a W6a follow-up, not in this PR.                                                                                                                                                           |
| 57  | workflow-escalation    | raised and resolved reach the journal and the emit track in order                                  | ported          | `an_escalation_raise_and_its_answer_are_journaled_in_that_order` (the journal order; the emit track is W7)                                                                                                                                                                       |
| 58  | workflow-escalation    | the payload is clipped to 2048 characters at the protocol boundary                                 | W3 projection   | Escalation payload clipped to 2048 characters at the protocol boundary. The projection hook is W3; the journal keeps raw facts in both implementations.                                                                                                                          |
| 59  | workflow-escalation    | three structured refusals are distinguishable and name the state                                   | covered         | `escalation_tests::an_escalation_with_no_ask_in_flight_is_refused_with_the_node_message`; `driver_owner::an_escalation_without_an_ask_is_refused_and_writes_nothing`                                                                                                             |
| 60  | workflow-escalation    | a withdrawal does not undo `already_resolved`                                                      | W7              | A withdrawal does not undo `already_resolved`. Rust `answer` returns `None` for unknown and resolved ids alike; the structured code is the `ResolveWorkflowQuestion` result (W7).                                                                                                |
| 61  | workflow-escalation    | pendingFor isolates runs on one table                                                              | W7              | `pendingFor` isolates runs on one table. Service registry read through the W7 tools.                                                                                                                                                                                             |
| 62  | workflow-escalation    | an actor's tools drop ResolveWorkflowQuestion and keep escalate                                    | covered         | agents `live_actor_tests::an_actor_is_denied_the_tools_node_denies_its_subagents` (the deny list); Rust has no `ResolveWorkflowQuestion` tool                                                                                                                                    |
| 63  | run-service escalation | a parked question appears in the snapshot's pendingQuestions and clears on answer                  | W7              | `pendingQuestions` in the snapshot. The snapshot read is `GetWorkflowRun` (W7).                                                                                                                                                                                                  |
| 64  | run-service escalation | a parked question appears in getRunDetail                                                          | W7              | `getRunDetail` carries parked questions. The read is `GetWorkflowRun` (W7).                                                                                                                                                                                                      |
| 65  | run-service escalation | raised and resolved both reach the live track and event paging                                     | W3 projection   | Raised and resolved on the live track and in event paging. The projection hook (W3) feeds the track and the paging.                                                                                                                                                              |
| 66  | run-service escalation | three structured rejections: unknown id, answered, not in flight                                   | W7              | Three structured rejections (unknown, answered, not in flight). The codes are the `ResolveWorkflowQuestion` results (W7); see row 60.                                                                                                                                            |
| 67  | run-service escalation | one table, several in-flight runs: qids and pendingQuestions isolated                              | W7              | One table, several runs: qids and `pendingQuestions` isolated. Service registry through the W7 tools.                                                                                                                                                                            |
| 68  | run-service escalation | the actor's model asks, the main model answers, the answer reaches the actor and the ask settles   | W7              | End to end: the actor asks, the main model answers via `ResolveWorkflowQuestion`, the ask settles. Owner W7; the owner's delivery path is row 44.                                                                                                                                |
| 69  | run-service escalation | stopping the run while parked interrupts the actor's escalate; a later answer is run_not_in_flight | W8              | Stopping a run while parked: the actor's escalate is interrupted, and a later answer finds no run. Owner W8 (cancel for runs in the background registry); the owner side is row 53.                                                                                              |

Parity gap, fixed in a separate commit (4e5bfec98).

- Resume identity (row 15). Node's `createActorSession` reads the journal's recorded session id and fails with `DriverError` (mismatch: expected = recorded, got = minted) before the factory runs. Rust did not compare, so a drifted id silently created a new session. The fix: `WorkflowDriver::minted_session_id(run_id, actor)` is a defaulted trait method (None), implemented by `ActorPort` with `mint_actor_session_id`. The scheduler checks the journal row against it before `create_actor_session` and settles the actor with `SessionState::Mismatched` (`DriverError` with `mismatch` expected = recorded, got = minted). Drivers without a rule are not checked, so the replay goldens (whose doubles record `sess:...` ids) are unchanged, and the full goldens suite passes. The test `a_journal_session_id_that_is_not_the_minted_one_fails_before_a_session_is_created` is no longer ignored.

Divergences recorded (not fixed here).

- Node counts model requests; the owner tests count turn starts and replies (see the translation above).
- The structured refusal codes for escalation (`run_not_in_flight`, `already_resolved`) are service-level; the Rust book returns `None`.
- The escalation payload clip (2048 characters) is a protocol projection (W7).
- World reads and artifact publish are wired in the owner, with a worker per job (W6b part 4, section 9.11). The production ports now exist (W7-4, section 9.19: `WorldReadPorts`, `ArtifactFsPort` and `ArtifactStorePort` in env-local `world_ports.rs`). Nothing constructs them yet: the run service (W7) wires them into the owner.
- The session close port exists since W6b part 6 (section 9.15): `ActorSessions::close_session`, called from the driver's dispose.
- The seed is dropped at the driver (`_seed`). Owner W5b (the amend import; countSource blocked).

Verification (this part).

- `cargo test -p rust-cli-workflow --lib --locked`: 151 passed, 0 ignored (after 4e5bfec98).
- `cargo test -p rust-cli-agents --lib --locked`: 328 passed.
- `cargo fmt` on the workflow crate; `rustfmt --check` on the new file.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: see the PR.

### 9.9 W6b part 1: the governor (as built)

This part is the process-level governor and the admission hook in the model request path, as Q7 decided. The rest of the W6b row is split below into parts 2 to 6.

**Where it lives.** `crates/model/src/admission.rs` is the port: `RequestAdmission`, `AdmissionTicket`, `AdmissionScope` and `AttemptSignal`. `crates/model/src/governor/controller.rs` is the AIMD state machine, a port of `dynamic-workflow/src/engine/concurrency.ts`. `crates/model/src/governor/mod.rs` is the process governor, a port of `workflow-concurrency-governor.ts`, with `process()` as the singleton and `default_concurrency` (Node's `resolveWorkflowDefaultConcurrency`). The hook is in `transport/` (`Connect.admission`). The entry wires it in `cli/src/assemble/models.rs` (`Assembled::port`): every provider model made by the entry gets the process governor unless the caller passes its own `RouteOptions.admission`.

**Constants (Node's, unchanged).** Decrease to `floor(cap × 3/4)` with floor 1. `+1` after K = 4 successes of the current epoch, and only with a waiter. Idle reset after 300 s with nothing in flight. `D = max(4, min(16, cores − 2))`. Automatic growth limit 2D. Buckets are per `provider/model` (`model_key`).

**Admission per attempt.** `Connect::attempt` acquires a ticket before each HTTP send, so a backoff sleep holds no slot. The outcome settles the ticket:

- `Connect::fail` settles with `AttemptSignal::of_error` before any renewal or backoff, so a waiting retry holds no slot either.
- The silent resend of an idle stream settles as transient.
- A stream read to the end settles as completed (`Read::finish`).
- A ticket dropped without settling (a cancel, a dropped stream, a terminal read error) counts as ended, as Node's `release()` does.

A cancel while queued returns `ModelError::Cancelled`, takes the request out of the queue, and takes no slot. A grant that raced the cancel is handed back and ended in the same lock section.

**Signals.** `AttemptSignal::of_error` maps the error the attempt ends with (a retry or a terminal error, the same rule for both):

- `RateLimited` is throttled (`rate_limited`) with its Retry-After as the cooldown.
- `Overloaded` is throttled (`provider_overloaded`) with no cooldown.
- `Network`, `Server` and `StreamIdle` are transient.
- Everything else is ended: quota, authentication, content, request size, and the rest. A provider-wrapped error classifies as its inner error (`peel`).

This is Node's mapping of its status events to the same four results, except that the stop set is read from the Rust error classes, not from Node's failure-policy table (see the divergences).

**Scopes.** `Observer` serves main-thread, compaction and side requests. It never queues, is counted in flight, and feeds the bucket, as Node's `observer()` does. `SessionSubagents` serves `QuerySource::Subagent` requests and queues. `Run` is in the port and the governor (a queue per run, rotation, cancel), but no request path produces it yet: the driver sets it in part 2.

**Tests.** The unit tests were written first and recorded red: 30 governor and controller tests failed on the `todo!()` stubs, and the admission mapping tests failed the same way. The green run: `rust-cli-model` 206 lib tests and 79 integration tests pass. The unit tests cover: the AIMD rules (the 3/4 decrease, the lastGood revert, the epoch damping, the streak and waiter rule, idle reset), the gate and the fast path's fairness, the observer, per-key buckets, run rotation, cancel while waiting, the Retry-After cooldown and its timer, the stop-set failure, the dropped-ticket rule, the batch of 429s counted once, the subagent queue, and the default concurrency. The integration tests in `tests/suite/governor.rs` run the transport against a fixture: a 429 takes the bucket from 8 to 6 and the retry completes on the same bucket; a 529 does the same; a success is counted once; the main thread is admitted while the one slot is held; a subagent waits, and a cancel leaves the queue and no slot; a subagent is admitted when the slot frees. The integration tests were written after the transport wiring, so their red run was not recorded separately. `cargo clippy --workspace --all-targets --locked -- -D warnings` is clean. The `rust-cli` crate's tests pass.

**Node divergences.**

1. Subagents share one queue. Node has one queue per parent session. The Rust request carries no parent session ID, so `SessionSubagents` takes an empty parent for every subagent. Fairness across parents differs until the driver or the subagent runtime passes the parent.
2. Workflow actors are not scoped. Their requests are `QuerySource::Subagent("workflow_actor")`, so they use the subagent pool, not a run queue. This is harmless while the gate is off (W9), but part 2 must scope them as `Run` before any run traffic. Done in part 2b (9.12): a request that names its run is admitted under `Run`.
3. The stop set comes from the Rust classifier (`QuotaExhausted`, `Authentication`, and so on), not from `resolveWorkflowModelFailurePolicy`. Part 3 ports the table. Where the two disagree, the table wins. **Closed in W6b part 3 (9.13):** the governor's `AttemptSignal::of_failure` reads the table's stop set (`is_workflow_stop`) before it maps the variant. The differences that remain are listed in 9.13 (divergences 22 to 34).
4. A cooldown wake is armed only when the cooldown is still in the future. Node arms a zero-delay wake when the cooldown has passed. Rust does not: a waiter leaving the queue (cancel or drop) runs `drain` at once, so a passed deadline is served without any timer (Codex review of #560, P1). Both give the same result.
5. The wake timer is a tokio task when a runtime is current, and otherwise one shared timer thread with a deadline heap (`scheduler()`), so a ticket dropped off the runtime still wakes its waiters and a wake costs a heap entry, not a thread (ocr #560). Node's is an unref'd `setTimeout`. The scheduler is called after the state lock is released, so a synchronous scheduler cannot deadlock.
6. The controller computes the cap changes, but they are not emitted. The `concurrencyChanged` event and its fan-out to engaged runs are part 2.
7. The growth limit is fixed at 2D. Node's run bounds (`setRunBound`, `clearRunBound`, the growth limit from a run's bound, seeding and `limit_lowered`) are part 2.
8. `NEVER_ABORTED` and the observer's own signal path are not needed: the Rust `acquire` takes a cancel token, and the observer never waits.
9. The cooldown is capped at 60 s (`MAX_COOLDOWN_MS`, the default `max_wait` of the Rust retry policy). Node has no cap on the governor's cooldown (`concurrency.ts` uses Retry-After as given), so a Retry-After longer than a minute freezes the bucket for a minute here, not for its full length. The deadline is saturating, so an absurd Retry-After cannot overflow (Codex #560 P2).
10. Each operation reads the clock once and uses that `now` for admission and for scheduling the wake. A deadline that falls between two reads cannot lose a wake (Codex #560 P1).
11. A truncated or malformed stream (`ModelError::Protocol`) settles as transient, like a stream idle. The transport retries it (provider-errors §3.2). Node has no truncation rule: a retried non-throttle failure settles as transient there, and a terminal one as ended. A terminal Protocol error here also clears the success streak, which is the conservative side (ocr #560).
12. Done in W6b part 2 (9.10): `AdmissionScope::Run(RunId)` and `SessionSubagents(ParentSessionId)` are newtypes. The `\0` prefixes still keep the namespaces apart by convention only.
13. Follow-up (any crate): a shared panic-payload message helper in `rust-cli-base`. There are four copies today (governor timer, base, tui-kit, workflow); the cross-crate refactor is out of scope for W6b part 1 (ocr #560).

**Not ported from the Node tests in this part.** The growth-limit and seeding cases, the run-bound cases, the fan-out and unsubscribe cases, and the zero-delay wake cases. They depend on part 2's run bounds and events. The Node parity of `tryAdmit` with a run that has a bound is not checked.

**Split of the rest of the W6b row.**

- **W6b part 2: run admission and events.** The driver calls `tryAdmit` and then `admit` per attempt (`askWaiting` with `backoff` while it sleeps, `askWaiting` with `slot`, and `askExecuting`). Run bounds and growth: `setRunBound`, `clearRunBound`, the seed rule, `limit_lowered`. The `concurrencyChanged` event with fan-out to runs engaged on the key. The workflow actor scope (divergence 2). The Node tests for these.
- **W6b part 3: model failure policy (done, section 9.13).** `resolveWorkflowModelFailurePolicy` and the driver's reading of its Stop set, shared with the governor, so divergence 3 closes.
- **W6b part 4: world reads and artifact publish (done, section 9.11).** `workflow-world-read.ts`, `workflow-git-world-read.ts` and `workflow-artifact-publish.ts`, with the fault cases.
- **W6b part 5: stall clock and quota timer (done, section 9.14).** `askProgress`, `runStalled`, and `dynamic-workflow-quota-resume.ts` (resume after `resetAt + 1 min`, once). The scripted-provider test through the owner is in; the desktop E2E waits for W7 and W9.
- **W6b part 6: `LiveRunGuard`, residency and the close chain (done, section 9.15).** The guard, the residency ledger, the close port and the dispose rules are ported. The run service that creates guards and the production closer are W7 (9.15, "What W7 must wire").

### 9.10 W6b part 2: run admission, bounds and fan-out (as built, part 2a)

Scope of this change: the governor side of run admission. Run bounds and growth (`setRunBound`, `clearRunBound`, the growth limit from the bounds, seeding, `limit_lowered`), and the `concurrencyChanged` fan-out to the runs engaged on a key. What is not in this change is listed at the end of this section (part 2b).

**Where it lives.** `crates/model/src/governor/controller.rs`: `set_growth_limit` (Node `setGrowthLimit`), `seed` (Node `seed`), the reasons `LimitLowered` and `Seeded`, and `Change` now carries `last_good`, `last_bad` and `cooldown_ms` as Node's change event does. `crates/model/src/governor/mod.rs`: `Governor::set_run_bound` and `clear_run_bound`, `subscribe` (returns a `Subscription`, whose `unsubscribe` is Node's unsubscribe function), `CapChange { key, change }`, `refresh_growth_limit` (Node `refreshGrowthLimit`), `note_run_used` (Node `noteRunUsed`), and `publish` (Node `fanOut`). `crates/model/src/admission.rs`: the newtypes `RunId` and `ParentSessionId` (follow-up 12 of 9.9).

**Rules (Node's, unchanged).** A bucket's growth limit is `max(2D, the largest bound among the runs in the bucket's runs)`. A run joins a bucket's runs on its first tracked admission (`AdmissionScope::Run`) on that key, and leaves them on `clear_run_bound`. A bound that raises the limit also seeds the cap to `min(bound, growth limit)`, unless a rejection happened within five minutes. A bound below the cap lowers the cap at once and emits `limit_lowered`. Fan-out reaches every subscribed run engaged on the key (in flight or queued). A bound-driven change also reaches every run in the bucket's runs, including an idle one.

**Ordering.** A settlement's change is fanned out before the run's in-flight count drops, so the run that caused it is still engaged (Node's order). Listeners are called after the state and listener locks are released, in the order the changes were produced.

**Tests.** Red first: `cargo test -p rust-cli-model --lib governor` failed to compile with 37 errors, all naming the missing API (`set_run_bound`, `clear_run_bound`, `subscribe`, `Controller::seed`, `Controller::set_growth_limit`, `ChangeReason::Seeded`, `ChangeReason::LimitLowered`, the `Change` fields, `CapChange`, `RunId`, `Subscription`). Green: the governor and controller suites are 56 tests; the full `rust-cli-model` run is 239 lib and 82 integration tests. `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --locked -- -D warnings` are clean.

Ported from Node: the growth-limit cases of `dynamic-workflow/tests/engine/concurrency.test.ts` (raising the limit changes no cap and the cap climbs one step at a time; lowering below the cap pulls it down at once with `limit_lowered` and clamped `lastGood`; lowering to a value not below the cap changes nothing; the limit never goes below initial), the seed cases (jump to the target within the limit, clamp to the limit, no-op at or below the cap, refused within five minutes of a rejection), and from `bootstrap/tests/workflow-concurrency-governor.test.ts`: auto-growth stops at 2D; a bound above 2D raises the keys the run has used and jump-starts them; a bound at or below 2D and the observer never raise the limit; `clear_run_bound` lowers the limit and reaches an engaged run with `limit_lowered`; retuning a bound overrides it in both directions; a run that used the key before its bound raises it when the bound is registered; a retune upward seeds the cap and reaches an idle run that has used the key; a 429 within five minutes stops the seed; fan-out reaches only engaged runs; a queued run hears changes and an unsubscribed run does not. New, with no Node counterpart: a listener may read the governor during fan-out without deadlocking.

The zero-delay wake cases are covered by the existing test `a_cancel_after_the_cooldown_deadline_serves_the_next_waiter_without_the_timer`: Rust serves a passed deadline without arming a timer (divergence 4 of 9.9).

**Node divergences (new in this part).**

14. Listeners run after the locks are released. Node's `fanOut` runs inside the same synchronous call. The order of changes within one operation is kept.
15. `Subscription` does not unsubscribe when dropped; `unsubscribe()` does. A kept Node closure behaves the same way.
16. `cooldown_ms` on a change is the value after the 60 s cap of divergence 9 (9.9). Node reports the raw Retry-After.
17. For one operation, the fan-out loops over changes outside and runs inside. Node loops over runs outside and changes inside. Each run sees its changes in the same order.

**Not done in this part (part 2b).** Part 2b is built in 9.12. What it leaves open is listed there.

Follow-up 12 of 9.9 is done: `AdmissionScope::Run(RunId)` and `AdmissionScope::SessionSubagents(ParentSessionId)`. The `\0` key prefixes still keep the namespaces apart by convention, as before.

### 9.11 W6b part 4: world reads and artifact publish (as built)

Status: built on `feat/rust-workflow-world-reads-w6b-4`, from `origin/fork`. Gate off; no production caller. Item 1 (the production host ports) is built in W7-4, section 9.19 below.

Node source: `workflow-world-read.ts` (773 lines), `workflow-git-world-read.ts` (458, pure), `workflow-artifact-publish.ts` (571), with the caps of `dynamic-workflow/src/facade/world-read-caps.ts` and `artifact-caps.ts`.

What is built (crate `rust-cli-workflow`):

- `world_git.rs`: the pure git half. Ref and path validation (Node's messages), the fixed argv of `git-changed-files`, `git-diff`, `git-status` and `git-log`, and the parsers (porcelain v2 with the rename and unmerged cases, the log's four NUL fields, path lists). `js_cmp` is JavaScript string order (UTF-16 units).
- `world_read.rs`: `execute_world_read(cwd, ports, op, args)` for `glob`, `read`, `grep`, the four git ops and `run`. Argument validation by position (the arity messages, `describe_arg`, the optional and count rules, `worldRunArgs` and the output modes). The caps (`caps` module) are checked with cap+1 probes and reject over the cap; nothing is truncated. The port is `WorldReadPorts` (blocking: glob, read, grep, run). `resolve_within_workspace` and `to_workspace_relative` are the shared lexical helpers.
- `artifact_publish.rs`: `execute_artifact_publish(PublishDeps, request)`: id, opts, store and session checks (in that order, as Node), the file path with the lexical check and a real-path check, the cap+1 read, the extension table (no sniffing), the markdown UTF-8 cap, and the store write with `CreateWorkflow`, `project` retention and the tool-call id `<run>:<site>@<ordinal>`. Ports: `ArtifactFsPort`, `ArtifactStorePort`.
- `world_host.rs`: the worker side. `WorldWiring` (read port, workspace, optional artifact half, the owner's mailbox handle). `spawn_world_job` runs a job on a std thread, catches a panic as a `DriverError`, and posts `ActorRequest::WorldSettled` or `ActorRequest::ArtifactSettled`.
- `driver_owner.rs`: `ActorPort::start_world_read` and `start_artifact_publish` queue a job when wired (without wiring a world read still fails with the W6a `DriverError`). `pump` hands queued jobs to `spawn_world_job`. `ActorDriverOwner::with_world`, `world_read`, `publish_artifact`, and the settle methods `world_settled` and `artifact_settled` (the mailbox dispatch). `has_artifact_store` is true only with a store.
- `error.rs`: `ErrorCode::WorldReadCapExceeded` (Node's code, appended as 23).

Node parity, by behaviour:

- Every Node message copied for the cases above. The cap values and the 300,000 ms run timeout are the Node values.
- Ticket outcomes match Node: a read settles with its value; a fault or a bad argument is a `DriverError`; an over-cap result is `WorldReadCapExceeded`; a publish settles with `{id, version}` and the full record is not returned to the script (the engine journals it).
- `publishedAt` is injected by the host (`now_ms`), since the engine has no clock.

Tests (all green on the Linux box, the workflow and runtime lib suites; `cargo clippy --workspace --all-targets --locked -- -D warnings` clean; `cargo fmt --all --check` clean):

- `world_git_tests.rs`: 17 cases (validation, argv, prefix, status, rename, unmerged, log, path lists, UTF-16 order).
- `world_read_tests.rs`: 28 cases with a fake port (arity and types, the optional rule, the count rule, glob cap and order, read containment, grep skip and both caps, the four git ops and their failure message, the git-diff cap, `run` argument shapes, output modes, timeout, spawn error, the stream cap, discard, tail).
- `world_read_real_tests.rs`: 6 cases with real git in a temporary repository run from a subdirectory (prefix stripping, the untracked file with a space and a non-ASCII name, changed files with and without a base, a relative diff, the log, and a non-repository failure).
- `artifact_publish_tests.rs`: 20 cases with fakes (the record key order and store arguments, file types, the symlink and containment cases, caps by UTF-8 bytes and by UTF-16 units, the store checks, the write failure, the extension table).
- `world_wiring_tests.rs`: 6 cases through the real mailbox: a glob and a read settle their ticket, a port fault fails the node, a panicking port fails the node, a markdown publish settles `{id, version}`, and no store refuses a publish. The first is Node's row 11 ("glob and read through the fs port"). The typed-ask half of that row is not re-tested here.

Divergences (recorded, not fixed here):

1. No production host port (resolved in W7-4: `StartCommand` has an argv mode, and the port is in env-local; see "9.19"). Before W7-4 the execution port took a shell string only, so the fixed git argv could not be sent through it without quoting. The Files port has no real path call. `GlobFiles` and `GrepSearch` return different shapes (mtime order, a `total` count, no head limit). `ToolArtifactStore::put` has no tool-call id or retention. The adapter over the machine ports is W7/W8 wiring. The real-git test runs git through a test-only `std::process` host, so the argv path is checked against git without a production adapter.
2. Workers. Node runs a read as a promise on the event loop; Rust runs it on a std thread and posts the settlement to the owner. The engine's settle order follows the posting order, and replay uses the recorded events, so the journal is unaffected.
3. Null and undefined. JSON has no `undefined`, so a `null` in an optional position is treated as absent (Node's explicit `undefined`). The error text says `null` where Node says `undefined`.
4. Paths outside the workspace. Node's `toWorkspaceRelative` writes `../` for a path outside the root. Here such a path is returned absolute. A glob under the workspace cannot produce one.
5. `world.run` has no permission gating, as in Node (authorization is at compile time).
6. Clippy: `result_large_err` is allowed in the new modules (`WorkflowError` is 248 bytes). Boxing it would split the engine's error type.
7. Ports: `ArtifactFsPort` reports a missing path, a directory and a non-file as separate faults, and the `too large` report is mapped to `ArtifactTooLarge` as Node does.
8. Tests. The bodies of the three Node files are read in full and mapped case by case below. Their `it.each` rows (17 artifact content types, 3 artifact opts shapes) are counted as cases, so the artifacts file has 48 cases, not 28. The real-filesystem containment cases (symlinks, real directories) are ported against a fake file port; the real-filesystem behaviour belongs to the production adapter (W7/W8).
9. Red runs were not recorded. The pure modules and the executors were written in one pass before the tests, and the suite was then run to green. The first run after wiring showed one red (a wrong expectation in the test: the ticket settles with `{id, version}`), fixed in the test.

Case-by-case mapping (parity gap closed on PR #563). Each Node case maps to a Rust test or to a divergence. Rust test names are in `crates/workflow/src/`. `node_cases` is `world_read_node_cases_tests.rs` or `artifact_node_cases_tests.rs`, the new tests written for this gap.

`workflow-driver-world-read-args.test.ts` (5 cases):

| Node case                                                     | Rust                                                                                                                                                                                | Status                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| passes well-formed args through to the fs port                | `world_read_tests::glob_is_workspace_relative...`, `read_returns_the_text...`; `node_cases::args_case_well_formed...`                                                               | mapped, new               |
| rejects a missing argument (DriverError, names op and `path`) | `world_read_tests::a_string_op_refuses_extra_and_missing...`                                                                                                                        | mapped                    |
| rejects a wrong-typed argument (42, undefined, array)         | `world_read_tests::a_non_string_argument...`; `node_cases::args_case_wrong_typed...` (array)                                                                                        | mapped, new for the array |
| rejects extra arguments                                       | `world_read_tests::a_string_op_refuses_extra_and_missing...` (glob with two)                                                                                                        | mapped                    |
| rejects rather than throwing synchronously                    | divergence: the Rust function returns `Result` and does not throw on argument shape. A port panic becomes a failed node in `world_wiring_tests::a_panicking_port_fails_the_node...` | divergence (structural)   |

`workflow-driver-world-run.test.ts` (17 cases):

| Node case                                             | Rust                                                                                                                                         | Status                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| passes argv, cwd, 300 s default and cap+1 to the port | `node_cases::run_case_the_request_carries_the_workspace_cwd` (red: `RunRequest` had no `cwd`; fixed); `world_read_tests::a_completed_run...` | mapped, red then fixed    |
| honours `timeoutMs` with no clamp                     | `node_cases::run_case_a_timeout_is_not_clamped`                                                                                              | mapped, new               |
| nonzero exit is a value                               | `world_read_tests::a_nonzero_exit_is_a_value_not_an_error`                                                                                   | mapped                    |
| timeout is a DriverError naming 300000 ms             | `world_read_tests::a_timeout_and_a_spawn_error...`; `node_cases::run_case_default_timeout_message...`                                        | mapped, new               |
| spawn error is a DriverError                          | `world_read_tests::a_timeout_and_a_spawn_error...`                                                                                           | mapped                    |
| no runtime allowlist                                  | `node_cases::run_case_a_command_that_was_never_declared_runs`                                                                                | mapped, new               |
| exactly cap bytes in full mode                        | `node_cases::run_case_exactly_cap_bytes_of_stdout_is_allowed`                                                                                | mapped, new               |
| stdout over cap, message points to `opts.output`      | `world_read_tests::full_output_over_the_stream_cap...`; `node_cases::run_case_over_cap_stdout_message...`                                    | mapped, new message check |
| stderr over cap                                       | `node_cases::run_case_stderr_over_cap...`                                                                                                    | mapped, new               |
| argument shapes refused, nothing run                  | `world_read_tests::run_argument_shapes...`; `node_cases::run_case_bad_argument_shapes...`                                                    | mapped, new cases         |
| output `full` equals default                          | `node_cases::run_output_case_explicit_full...`                                                                                               | mapped, new               |
| discard: no inline bytes, empty streams               | `world_read_tests::discard_sends_no_inline_bytes...`                                                                                         | mapped                    |
| discard keeps a nonzero exit as a value               | `node_cases::run_output_case_discard_returns_a_nonzero_exit...`                                                                              | mapped, new               |
| tail returns the last n per stream                    | `world_read_tests::tail_returns_the_port_tail...`                                                                                            | mapped                    |
| tail accepts 1 and the cap                            | `node_cases::run_output_case_tail_accepts_one_and_the_cap`                                                                                   | mapped, new               |
| tail with no port tail is a DriverError               | `world_read_tests::tail_returns_the_port_tail...` (second half)                                                                              | mapped                    |
| bad output shapes refused before running              | `world_read_tests::run_output_arg...` (unit); `node_cases::run_output_case_bad_output_shapes...`                                             | mapped, new cases         |

`workflow-driver-artifacts.test.ts` (28 `it` cases, plus 17 `it.each` content-type rows and 3 `it.each` opts-shape rows, 48 in all):

| Node case                                                      | Rust                                                                                                                                                                | Status                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| writes bytes and returns a full record                         | `artifact_publish_tests::a_file_publish_reads...`; `world_wiring_tests::a_markdown_publish...` (outcome `{id, version}`)                                            | mapped                                   |
| four store args (retention, toolName, toolCallId, sessionId)   | `artifact_publish_tests::a_markdown_publish_writes_text...` (session, tool call id, CreateWorkflow, project); file extension in `a_file_publish_reads...`           | mapped                                   |
| dot segments keep subdirectory source                          | `artifact_publish_tests::a_file_publish_reads...` (`./sub/../sub`); `node_cases::file_case_dot_segments...`                                                         | mapped, new                              |
| path outside workspace is refused                              | `artifact_publish_tests::a_path_that_leaves_the_workspace...`                                                                                                       | mapped                                   |
| absolute path outside is refused                               | same test (absolute half)                                                                                                                                           | mapped                                   |
| symlink inside pointing outside, judged by real path           | `artifact_publish_tests::a_symlink_inside_the_workspace_that_points_outside...` (fake fs)                                                                           | mapped; real-fs behaviour tested in W7-4 |
| symlink inside pointing inside is published                    | `artifact_publish_tests::a_symlink_inside_the_workspace_to_another_file...` (fake fs)                                                                               | mapped; real-fs behaviour tested in W7-4 |
| missing path and directory are source-missing                  | `artifact_publish_tests::a_missing_path_and_a_directory...`                                                                                                         | mapped                                   |
| over 20 MiB is refused, not truncated                          | `artifact_publish_tests::a_file_over_the_cap...`                                                                                                                    | mapped                                   |
| port probed with cap+1; exactly cap allowed                    | `node_cases::probe_case_the_port_is_asked_for_cap_plus_one...` (red: port asked for cap, fixed to cap+1); `node_cases::probe_case_one_byte_over...`                 | mapped, red then fixed                   |
| port's own too_large is ArtifactTooLarge                       | `artifact_publish_tests::a_port_too_large_report...`                                                                                                                | mapped                                   |
| extension table (17 rows)                                      | `node_cases::type_case_every_extension_of_the_table...`                                                                                                             | mapped, new                              |
| unknown and missing extension is octet-stream                  | `artifact_publish_tests::an_unknown_or_missing_extension...`                                                                                                        | mapped                                   |
| `opts.contentType` overrides the table                         | `artifact_publish_tests::opts_content_type_overrides...`                                                                                                            | mapped                                   |
| `contentType` with parameters is refused                       | `artifact_publish_tests::opts_content_type_overrides...` (second half)                                                                                              | mapped                                   |
| markdown writes text, sourcePath absent                        | `artifact_publish_tests::a_markdown_publish_writes_text...`; `node_cases::markdown_case_the_record_has_no_source_path...`                                           | mapped                                   |
| 256 KB exact allowed, one byte over refused                    | `artifact_publish_tests::markdown_is_measured_in_utf8_bytes...`                                                                                                     | mapped                                   |
| multi-byte counted in UTF-8                                    | same test                                                                                                                                                           | mapped                                   |
| markdown ignores `opts.contentType`                            | `node_cases::markdown_case_the_content_type_option_is_ignored`                                                                                                      | mapped, new                              |
| opts string, array or null refused (3 `it.each` rows)          | `artifact_publish_tests::unknown_opts_keys...` (array); `node_cases::opts_case_a_string_an_array_or_null...`                                                        | mapped, new cases                        |
| title and description must be strings                          | `artifact_publish_tests::title_and_description_must_be_strings...`; `node_cases::opts_case_a_non_string_description...`                                             | mapped, new                              |
| title and description over the cap refused; at the cap allowed | `artifact_publish_tests::an_over_long_title...`; `node_cases::opts_case_description_over_the_cap...`                                                                | mapped, new                              |
| unknown opts keys ignored                                      | `artifact_publish_tests::unknown_opts_keys...`                                                                                                                      | mapped                                   |
| invalid id is a DriverError                                    | `artifact_publish_tests::an_invalid_id...`; `node_cases::id_case_an_over_long_or_slashed_id...`                                                                     | mapped, new                              |
| missing payload fails loudly                                   | `node_cases::payload_case_a_missing_path_or_content...`                                                                                                             | mapped, new                              |
| no store: both members unavailable                             | `artifact_publish_tests::no_store_is_refused_before_any_file_is_read`; `node_cases::store_case_markdown_with_no_store...`; `world_wiring_tests::without_a_store...` | mapped                                   |
| text-only store: file refused, markdown published              | `artifact_publish_tests::a_text_only_store_publishes_markdown...`                                                                                                   | mapped                                   |
| store present, no parent session: fails                        | `artifact_publish_tests::a_store_without_a_parent_session...`                                                                                                       | mapped                                   |
| no store: file not read                                        | `artifact_publish_tests::no_store_is_refused_before_any_file_is_read` (reads empty)                                                                                 | mapped                                   |
| store write failure is DriverError with the reason             | `artifact_publish_tests::a_store_write_failure...`                                                                                                                  | mapped                                   |

Divergences from the Node cases (none is a behaviour gap in the port itself):

- The real-filesystem cases (symlinks, real directories, `realpath` of the workspace) run against fake ports in the workflow crate. The production `ArtifactFsPort` runs them on a real filesystem in W7-4 (`env-local` `world_ports_tests.rs`).
- `publishedAt` is checked against the injected clock, not a window around `Date.now()`.
- Node's `describeArg` says `undefined` where Rust's JSON says `null` (divergence 3 above).
- The Rust `WorldReadPorts::run` receives `cwd` in the request, as Node's `deps.cwd`. The W7-4 port honours it (`WorldPorts::run` runs in `RunRequest.cwd`).

Reds found while closing the gap:

1. `RunRequest` had no `cwd`, so the world-run cwd case did not compile (red). Fixed: `cwd` is in the request, and git and `run` pass the workspace root.
2. The artifact file probe asked the port for `cap` bytes; Node asks for `cap + 1` (red, behaviour). Fixed in `read_capped`.
3. Two fixture mistakes in the new tests (the glob fake used another workspace root; the tail fake returned no tail). Corrected in the tests. Not behaviour reds.

Review round (ocr on 492c73682, PR #563). Verdicts per finding:

1. Valid. Git text reads (prefix, changed files, status, log) now refuse output that hit the 4 MiB inline limit, with `WorldReadCapExceeded`. `git.diff` keeps its own cap check. Node has no such check (its git text reads take the truncated text silently); the Rust refusal is a divergence, and the Node gap is a follow-up. Red test `git_output_that_hit_the_inline_limit...`, now green.
2. Valid, in both ports. A path that starts with `:` is refused (pathspec magic: `:/x`, `:(top)x`, `:!x`, `:`), in Rust (`validate_git_path`) and Node (`validateGitPath`). Red: Rust `a_git_path_that_starts_with_a_colon...`; Node `workflow-git-world-read-pathspec.test.ts` 4 of 5 red, then green. Parity: the same message in both. `workflow-git-world-read.ts` was already 21,831 bytes, over the staged-file size guard, so its four longest doc comments were shortened to bring it to 19,425 bytes. No code changed. A sibling module was not used, because a new source file must sit in a managed architecture module.
3. Valid. Git runs pass `caps::RUN_DEFAULT_TIMEOUT_MS`. `RunRequest.timeout_ms` documents that `None` means the port's own default. Red `git_runs_carry_the_default_timeout`, now green.
4. Valid. Worker threads are created with `thread::Builder`. A failed spawn posts a `DriverError` for that node only. Divergence: no test forces a spawn failure (no injection point), so this path is reviewed, not tested.
5. Valid. Node does not bound world jobs (spec 9.5: outside the actor cap). Rust bounds them: `WORLD_JOB_LIMIT` = 8 running, the rest queued in the owner, a settled job starts the next. Divergence recorded. Red `world_jobs_are_bounded_and_the_rest_wait` (peak 24), now green.
6. Valid. A failed engine settlement (journal write) is kept in `deferred_errors` and returned by the next owner call, not only logged. No test: a journal write failure cannot be injected through the owner here.
7. Valid. Once the run has settled and no world job is running or queued, the owner drops its copy of the mailbox handle, so the owner loop can end. Red `the_mailbox_closes_after_the_run_settles_with_wiring_attached` (timed out), now green.
8. Valid, but unreachable through the public API: the engine checks `has_artifact_store` before it calls `start_artifact_publish`. Fixed anyway: a publish job with no wiring settles its node with `ArtifactStoreUnavailable` in the pump, not silently. No test (unreachable).
9. Valid. `got null.` in the markdown content message, as the other shape errors. Red `an_absent_markdown_content...`, now green.
10. Valid. The panic message is kept in the node error (`panicked: <message>`), as `actor_turns` does. Red `a_panic_message_from_the_port...`, now green.
11. Valid. `let _ = cwd;` removed.
12. Valid. The output-shape message is built from `RUN_TAIL_MAX_BYTES`, not the literal.
13. None beyond the above.

Delta on cf40f1576: (a) the truncation refusal no longer keys on the sentinel value `GIT_TEXT_OUTPUT_BYTES`. `run_git` takes an explicit `Truncation`: `Refuse { hint }` for the text reads, `CallerChecks` for `git.diff`, which keeps its own cap. Test `git_diff_reports_its_own_cap_even_at_the_text_read_limit_size`. (b) The refusal hint is per op: log says "Lower the count.", status and the prefix say "Narrow the workspace.", changed files says to pass a base or narrow the workspace. Red on the log hint (`a_truncated_log_says_to_lower_the_count...`), then green.

What is left (W6b part 4 follow-ups):

- Done in W7-4: the production host port (`WorldReadPorts`, `ArtifactFsPort`, `ArtifactStorePort` in env-local), with the argv mode on `StartCommand`. See "9.19".
- The typed-ask half of row 11 (a script's world result feeding an ask) through the scheduler, when a caller exists.
- Node test bodies for the three files in item 8, read and transcribed where a case differs from its title.

### 9.12 W6b part 2b: run admission wiring, events and the owner's governor link (as built)

Scope: the parts of 9.10's part-2b list that have a production home without the run service. What is in this part is listed first; what is not is at the end.

**Built.**

1. **Actor scope (divergence 2 of 9.9).** A workflow actor's requests are admitted under `AdmissionScope::Run(run)`, not the session pool. The run id travels as a plain string: `ActorRunBase.admission_run` (runtime) → `ActorRun.admission_run` (agents) → `LiveAgent.admission_run` → `QueryRequest.admission_run` (kernel-api, typed `WorkflowRunId`, serialized only when set) → `RunScope` (query) → `RequestOptions.admission_run` (kernel-api, `serde(skip)`, the workflow's name; `options.run` is the kernel query run and is not reused) → `Connect` in the transport, which maps `Some(run)` to `Run` before the source rule. A request with no run keeps the 9.9 mapping. A subagent the actor starts does not inherit the field (its `LiveAgent` is built by the Agent tool with `None`). The field reaches the turn's requests and the requests built from the same run scope; compaction is built from that scope too, and is not tested separately.
2. **The events (9.10's list, item 2).** `RunEvent::NodeWaiting { instance, wait }` (`node-waiting`, with `cause`, and `reason`, `attempt`, `delayMs`, `retryAfterMs` only when set), `NodeExecuting` (`node-executing`) and `ConcurrencyChanged` (`concurrency-changed`, the change's fields in Node's order). They are journaled as `dwf_event` rows through the existing `to_json` path and write no `dwf_node` row. The node-store reducer already reduces all three (W3). The engine methods `ask_waiting`, `ask_executing` and `concurrency_changed` are Node's `askWaiting`, `askExecuting` and `concurrencyChanged` (`engine.ts:656-678`): the first two are ignored after settlement and for an ask that is not live; the last is ignored only after settlement. `Identity::stamp` gives the three no phase, as Node's `record` does.
3. **The owner's governor link (item 3).** The workflow crate defines the port `run_concurrency::RunConcurrency` (`set_run_bound`, `clear_run_bound`, `subscribe`), so the crate still does not depend on the model crate. `ActorDriverOwner::attach_concurrency` is Node's launch registration: it sets the bound to the run's cap, then subscribes. The listener runs on the governor's thread and only posts `ActorRequest::ConcurrencyChanged` to the mailbox; the owner journals it through `concurrency_changed`. `ActorDriverOwner::set_max_concurrency` is the retune: the engine's cap changes, and the bound is re-registered with the new cap (Node's `runBoundTarget` does the same on every `setLimit`). The link is released by its `Drop`: the subscription ends, then the bound is cleared. `pump` drops it when the engine has settled, so the release happens once. The owner dropped without settling, and a second `attach_concurrency`, release the first link the same way. The bound is floored and never below 1; a non-finite cap (only possible from the config) binds 1.

The run an actor belongs to is cleared when its turn ends and when it is resumed (`finish_actor_turn`, `restart`), so a resumed actor is never admitted under a run that is gone. Each turn sets it again from its own `ActorRun`.

**Tests.** Node's `engine-concurrency-observations.test.ts` (the three events, the live and the late cases) and the owner's bound, retune, journal and release order are in `engine_tests.rs` and `run_concurrency_tests.rs`. The event key order is in `event.rs`. The actor scope is checked at three levels: the transport and the scope mapping (`model/tests/suite/governor.rs`, `a_workflow_actors_request_is_admitted_under_its_run`, a recording admission over the governor), the runtime (`every_actor_turn_carries_the_workflow_run_it_is_admitted_under`) and the agents request (`an_actor_turns_model_request_carries_its_workflow_run`).

**Red.** The actor-scope integration test was recorded red first, as a compile error (`no field admission_run on RequestOptions`). The engine, event and owner tests were written before their code, but the first compile came after the code was written, so no separate red run is recorded for them.

**Checks.** `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings` clean. `cargo test` green for `rust-cli-workflow` (276), `rust-cli-model` (241 lib, 83 integration), `rust-cli-runtime`, `rust-cli-agents`, `rust-cli-query` and `rust-cli-kernel-api`.

**Node divergences (new in this part).**

18. The `concurrency-changed` key order follows the Rust change struct (`key, previous, next, reason, lastGood, lastBad, cooldownMs`), which matches the `ConcurrencyChange` interface. Node's order comes from the governor's own object. The Node tests compare with `toEqual`, so the order is not pinned on the Node side.
19. A nested subagent of an actor does not inherit the run's admission (divergence 1 of 9.9 applies to it: it uses the session pool). Node's sub-runtime admission was not checked for this case.
20. On release, the subscription ends before the bound is cleared. Node clears the bound in the launch's `finally` and ends the subscription at the driver's dispose. The order of the two is not observable to the journal.
21. The governor's change reasons reach the workflow as the open strings of Node's `ConcurrencyChangeReason`. The mapping from the model's `ChangeReason` is the adapter's job, and no adapter exists yet (see below).

**Not done (left for later parts).**

- **Status (W7-3, 9.20):** the owner's feed and routing are built, and the turn side's source is `AskObserver`. The slot-queue wait has no source yet (divergence 68).
- **The source of `node-waiting` and `node-executing` (9.10 item 2's driver half).** Nothing calls `ask_waiting` or `ask_executing` in production. The signal path from the transport is missing: a queued admission (`slot`), the backoff of a retry (the `Retrying` notice's delay, Node's `backoff` with `reason`, `attempt`, `delayMs` and `retryAfterMs`), and the request's start after a wait (Node's `model_request_started`). It needs a notice from the transport to the owner through the mailbox. Left for the part that wires the actor turn to the transport (W7, with the run service).
- **Built in W7-3 (9.20):** `GovernorRunConcurrency` in `cli/src/frontends/workflow_governor.rs`. The original gap follows. **The production `RunConcurrency` adapter** over the model crate's `Governor`, with the reason mapping. Nothing constructs it, and nothing calls `attach_concurrency` or `set_max_concurrency` outside the tests. The owner runs ungoverned, as Node does without a governor.
- **The run service (still open after W7-3; W7-5).** Rust has no run service yet (W7/W8). Node's launch and retune call sites (`dynamic-workflow-run-launch.ts`, `workflow-run-control.ts`'s `runBoundTarget`) are the place where `attach_concurrency` and `set_max_concurrency` are called. The W7 run service must call them.
- **Built in W7-3 (9.20):** `ActorRunBase::for_run` sets the admission run, and `workflow_assembly::actor_turns` builds the turn side the run uses. The original gap follows. **The production `ActorRunBase`.** Nothing builds an `ActorRunBase` with an `admission_run` outside the tests, so the actor scope is dormant until the run service builds the runner for a run.

### 9.13 W6b part 3: model failure policy (as built)

This part ports Node's `resolveWorkflowModelFailurePolicy` (`apps/zcode-cli/packages/adapters/src/model/workflow-model-failure-policy.ts`) and the driver's reading of it (`bootstrap/src/app/workflow-driver-model-failure.ts`), and makes the governor read the same table, so divergence 3 of 9.9 closes.

**Where it lives.** The table is in `crates/kernel-api/src/workflow_failure.rs`: `resolve_failure_policy` takes `FailureFacts` (Node's `reason`, `code` and `providerCode`), `facts_of` and `model_failure_policy` read a `ModelError`, `next_unrecognized_streak` counts the unrecognized business codes, and `is_workflow_stop` is the governor's test. It lives in kernel-api because the model crate (the governor) and the workflow crate both already depend on it, `ModelError` is defined there, and neither of those two crates depends on the other, so no cycle is needed. The workflow crate gains a kernel-api dependency. The workflow side is `crates/workflow/src/model_failure.rs`: `TurnFailure` (the message plus the typed error), `transient_backoff_ms`, the `RedriveClock` port with `ThreadClock` for production, `provider_stop_error`, and `retry_after_of`. The owner (`driver_owner.rs`) has `turn_failed` (now taking a `TurnFailure`), `schedule_redrive`, `redrive_due`, `attach_redrive` and `settlement`. The governor's test is in `crates/model/src/admission.rs`, `AttemptSignal::of_failure`.

**Where the W6a driver was.** It had no classification. Every turn failure failed the ask with `DriverError` and the failure's text, and the text was all that crossed the turn boundary (`TurnRunner::run_turn` returned `Result<String, String>`). Nothing was ad hoc to replace, so the part threads the typed error through: `ActorTurnEnd::ModelFailed { message, model }` in agents (from `QueryError::Model`, with the same text `Failed` carries), mapped to `TurnFailure` by the runtime's `AgentTurnRunner`. A failure that is not a model error still takes the old path.

**The rules.**

- The table, in Node's order: cancelled is `Cancelled`. A provider code in the quota set is `Stop(quota)`, checked before the reason (1005 is `invalid_request` in the classifier). `auth_failed` is `Stop(auth)`. A not-configured reason or code is `Stop(not_configured)`. `model_not_found` is `Stop(model_unavailable)`. `context_exceeded` is `ContextExceeded`. `invalid_request` is `Stop(invalid_request)`, except the `invalid_model_response` code. An unrecognized code (reason `unknown` with a provider code) at a streak of 10 is `Stop(other)`. Everything else is `Retry`.
- The reason of a provider business failure is the provider's own `reason` (the zhipu table's mapped reason, from `ProviderFailure`). Any other error takes its variant's reason (`variant_reason`, in the same file).
- A permanent failure stops the run with `stopped(provider)` and a `ProviderStop` error whose details carry `kind`, `reason`, `subagent`, `subagentName` (when set), `providerId`, `modelId`, `providerCode` and `rawMessage` (2 000 characters at most), as Node writes them.
- A context overflow fails only that ask, with `ContextLimit` and Node's text.
- A retry (or a cancelled attempt, as in Node's switch default) emits `askWaiting` with cause `backoff`, the reason, the attempt, `delayMs` and `retryAfterMs` when set, and schedules a redrive. The redrive starts a turn with `TRANSIENT_CONTINUE_PROMPT`, epilogue 0, the ask's own submit schema, and the same interaction. The script never sees the failure.
- The backoff is `transient_backoff_ms(attempt, random)`: 2 s doubling to 60 s, multiplied by a jitter in `[0.5, 1]`, rounded. A positive Retry-After on a rate limit replaces it. The attempt counts per ask.
- The jitter and the clock are injected. The owner holds a `RedriveWiring` (the mailbox handle and an `Arc<dyn RedriveClock>`), attached by `attach_redrive`. The redrive job posts `ActorRequest::RedriveDue`. `redrive_due` starts the turn only if the ask is still the session's live, uncancelled ask, so a redrive due after settlement or cancellation starts nothing.
- Without an attached clock a retry fails the ask with `DriverError`, so a transient failure can never hang a run silently.
- The governor. `AttemptSignal::of_failure` returns `Ended` when `is_workflow_stop` holds, before it maps the variant. So a quota code on a 429 ends the attempt and does not cool the bucket. Before this part it was throttled with the Retry-After as its cooldown, which is the freeze that Node's comment on `isWorkflowStopFailure` describes. The governor reads the table with a streak of one, as Node's governor does.

**Tests.** Red first, then green.

- `kernel-api`, `workflow_failure_tests.rs` (11 tests, Node's table cases on facts, then on `ModelError`). The bodies were `todo!()`. Red: `cargo test -p rust-cli-kernel-api --lib workflow_failure` gave 11 failed and 0 passed, each panicking on `not yet implemented`. Green: 11 passed.
- `model`, `admission_tests.rs`, `a_quota_code_on_a_429_ends_the_attempt_and_does_not_cool_the_bucket` (1 test). Red: `left: Throttled { reason: RateLimited, retry_after_ms: Some(60000) }`, `right: Ended`. Green after the table check. The model crate is then 242 lib tests and 83 integration tests, all passing.
- `workflow`, `driver_model_failure_tests.rs` (8 tests: the quota stop with its details, the context overflow, a transient redrive with its jittered delay and its continue prompt, the doubling to 60 s with Retry-After precedence, the tenth unrecognized code across redrives, a redrive due after settlement, a failure with no model error, a retry with no clock), and `model_failure_tests.rs` (3 tests on the backoff curve). Red: the driver tests did not compile against the old API: `cargo test -p rust-cli-workflow --lib --no-run` gave 8 errors (`unresolved import TurnFailure`, `no method attach_redrive`, `no method settlement` (4 sites), `no variant ContextLimit`). The backoff tests were written against a `todo!()` stub in the same change, but they were not run on their own before the driver compiled, so their red run is not recorded. Green: the workflow lib is 292 tests, all passing, including the driver's 8 and the backoff's 3. The `ErrorCode` round-trip test now lists 25 codes.
- `runtime`, `actor_turns_tests.rs`, `a_quota_failure_on_the_agents_turn_stops_the_run_as_provider` (1 test). The typed error goes from a scripted `ActorTurnEnd::ModelFailed` through the bridge to the owner, and the run stops with `ProviderStop` kind `quota`. Green: runtime lib 159 tests, all passing.
- Totals of the touched crates, all green: kernel-api 415 lib; model 242 lib and 83 integration; workflow 292; runtime 159 lib, with its integration suites; agents 331. `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --locked -- -D warnings` are clean.

**Review round (ocr on aa81ed0fb, eleven findings, fixed on the same branch).** Each behaviour change had a red test first. Red, before the fixes: kernel-api, 2 failed (`content_size_and_unsupported_failures_stop_as_invalid_requests`, `an_unknown_provider_reason_is_read_as_unknown_for_the_streak`; the fallback test already passed, since the fallback retried). Workflow, 9 failed: six driver tests (`a_redrive_the_clock_cannot_schedule_fails_the_ask_with_driver_error` hung with the ask live, `unrecognized_failures_interleaved_with_successes_never_stop_the_run` stopped at the tenth code, `a_redrive_whose_interaction_is_gone_fails_the_ask_with_driver_error` left the ask live, `a_redrive_job_that_fires_after_settlement_posts_nothing` posted a request, `the_stats_of_an_ask_carry_across_its_redrives` read 3 where 5 is right, `a_quota_stop_with_retry_after_carries_its_reset_time` had no `resetAt`) and three reset-time tests that panicked on `todo!()`. Green after the fixes: kernel-api 419 lib; workflow 301 lib (driver tests 14, backoff and reset-time tests 6, the rest unchanged); runtime 159 lib, agents 331, model 242 lib and 83 integration, all unchanged in count and passing. `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --locked -- -D warnings` are clean.

The fixes, by finding: (1) `RedriveClock::after` returns whether it scheduled; a refused job fails the ask with `DriverError` before `askWaiting` is written. (2) the four Rust-only deterministic variants stop as `invalid_request`; `FallbackTriggered` retries. (3) the streak resets when a turn reaches the owner (`turn_ended` or `submit_result`). (4) a redrive whose interaction is gone fails its ask in `redrive_due`. (5) settlement clears the mailbox slot that a pending job reads when it fires. (6) the agents turn moves its error rather than cloning it. (7) the Fork comment sits on its module. (8) a provider reason outside the known vocabulary reads as `unknown`. (9) a redriven turn's counts are added to the counts its earlier turns reported. (10) `resetAt` is written for a quota stop. (The clock also gained `now_ms`, so the owner reads no wall clock itself, which clippy's `disallowed_methods` requires.)

**Delta review (ocr on 762d1c4f0, seven findings).** A provider that reports a rejection under its own reason `content_blocked` or `request_too_large` is read as `invalid_request` (stop). It was known but had no row, so it retried forever. The provider reasons the variants produce are named constants shared by `variant_reason` and the known vocabulary, and a guard test checks every variant. The refused-redrive message names the model reason. The stale `RED STAGE` markers are removed. Red before the fix: one kernel-api test and two driver tests (the provider-reason stop and the message). The guard test passed before the fix, since it guards the existing invariant.

The interleaved-streak test ends its success with a rejected `submit_result`, not a `turn_ended`. The earlier version ended each round with a `turn_ended`, and the second round's turn end settled the ask as `ResultNotSubmitted`. That was test setup, not a driver fault: a typed ask has one nudge per ask (Node's `nudgesRemaining`, `scheduler-submit.ts`, decremented only at a turn end), the first round spent it, and a second turn end without a submit settles as Node does. Probes confirmed that a redrive, one or nine of them, does not spend the nudge. The characterisation test `a_redrive_does_not_spend_the_nudge_of_its_ask` pins that. A rejected submit is a turn that reached the owner and keeps the ask live, and it runs the same reset line.

**Node divergences (new in this part).** The numbering continues from 9.12.

22. A Rust-only row: `QuotaExhausted` with no provider business code is `Stop(quota)` (reason `quota_exhausted`). Node always has a quota code, so this row has no Node counterpart. Without it a bare quota error would redrive forever.
23. `ContentBlocked`, `RequestTooLarge` and `CurrentAttachmentsTooLarge` read the reason `invalid_request` and stop (review finding 2; this revises the earlier retry). Node's equivalent wire failures are a 400 or 422, which its classifier maps to `invalid_request`, a stop row. Node has no content-filter error (`sensitive` is a finish reason, not a failure) and no 413 branch, so the parity is with the outcome of the nearest Node failure, not with a string.
24. `Unsupported` reads `invalid_request` and stops, as in 23: it is a deterministic rejection of the request. `FallbackTriggered` reads `unknown` and retries. It is raised only after consecutive overloads have already moved the request to a fallback model, and Node retries an overload, so the same retry applies.
25. The table's rows for `model_not_found`, the not-configured codes and `invalid_model_response` have no Rust input: no `ModelError` carries those codes. Provider `3006` therefore becomes `Stop(invalid_request)` where Node's adapter gives `model_unavailable`. The rows are covered by the table tests only.
26. The unrecognized streak is counted by the owner, per ask. It resets when a turn reaches the owner (`turn_ended` or `submit_result`), since such a turn has finished its model requests (review finding 3). Node counts it inside the runner's attempt loop for one request and carries it to the driver on the error. A request that succeeds ends that loop, so the reset is the same rule at the owner's granularity.
27. `resetAt` is ported (review finding 10): Retry-After when it is plausible, else the provider's text read as Beijing time, both inside Node's window (one day back, 35 days ahead). It is read from the injected clock. A quota stop on an owner with no clock writes no `resetAt`. Part 5 reads it (9.14, where the quota timer arms at `resetAt + 1 min`); part 5 does not compute it.
28. The `Cancelled` policy redrives, as Node's switch default does. The runner's cancel path reports nothing first, so this is reached only for an attempt cancelled while the ask was not.
29. The governor's `AttemptSignal` still maps `Protocol` as transient (9.9, divergence 11). The table gives `Protocol` the reason `unknown`, which retries, so the two agree on the outcome.
30. The production clock is `ThreadClock`: one thread per redrive, which sleeps and then posts. Review finding 5 asked for one timer thread as optional; it is not done. The job reads the mailbox out of a slot when it fires, and settlement clears the slot. So a pending job holds no mailbox handle and posts nothing, and the owner's shutdown is not held for up to 60 s. No production owner attaches the clock yet: the run service (W7) does, and part 5 attaches the stall clock with it (9.14). Until then a transient failure in a real run fails the ask with `DriverError`, the same gap as 9.12's unwired governor link.
31. A clock that refuses a job (`RedriveClock::after` returns false, as a failed thread spawn does) fails the ask with `DriverError` at once, before `askWaiting` is written. Node's `setTimeout` cannot refuse. This is a Rust-only failure mode, kept so that a retry never waits for a job that will never run (review finding 1).
32. The attempt counter is per ask (`ActiveAsk.attempts`). Node's `transientAttempts` lives on the session state. A new ask on the same session starts again at 1 in both, so the delays agree in practice.
33. `rawMessage` is the turn's failure text (the error's `Display`, as the agents turn carries it). Node uses the adapter error's message. For a quota error the Rust text keeps its `API Error:` prefix.
34. The subagent label is `Ref::key()` (`site@1`), which is Node's `refToString` format. The persona name, when there is one, replaces it in the message, as Node's `subagentLabel` does.

**Not done here.** The production clock is not attached (divergence 30). The stall clock observes a redrive that goes on and notifies; it does not bound it (9.14, divergence 42). The quota `resetAt` is read by part 5 (divergence 27). The scripted-provider test through the owner is in part 5 (9.14); the desktop E2E is W7 and W9.

### 9.14 W6b part 5: stall clock and quota timer (as built)

This part ports Node's run-level stall clock (`createRunStallClock` in `workflow-driver-concurrency.ts`, its observer in the driver), the `node-progress` and `run-stalled` events with the engine's `askProgress` and `runStalled` passthroughs, and the quota auto-resume (`bootstrap/src/app/dynamic-workflow-quota-resume.ts`). The rest of the W6b row is parts 6 (the guard and residency) and W7 (the run service that attaches these).

**Where it lives.**

- `crates/workflow/src/stall_clock.rs`: `RunStallClock`, `RunStallInfo` and `WORKFLOW_STALL_NOTIFY_AFTER_MS` (twenty minutes). Time and timers come from `RedriveClock` (part 3): `now_ms` and `after` are reused, and no second clock abstraction is added. The clock cannot cancel a job, so each arming takes a generation, and a job whose generation is no longer the armed one does nothing.
- `crates/workflow/src/driver_owner.rs`: `attach_redrive` also attaches the stall clock. Its job posts `ActorRequest::StallDue` to the same mailbox slot as the redrives (`actor_mailbox.rs`), so a settled run posts nothing. `release_redrive` disposes it at settlement. The owner exposes `model_request_completed()`, `model_retry_scheduled(reason)` (which drops the two non-failure reasons, as Node's `NON_FAILURE_RETRY_REASONS` does) and `stall_due(generation)`. `concurrency_changed` notes the cap. `ask_stats` records `node-progress` before `usage-updated`, as Node's `reportTurnObservations` does.
- `crates/workflow/src/engine.rs` and `event.rs`: `ask_progress` (a passthrough, dropped after settlement) and `run_stalled` (dropped after settlement); the `AskProgress` argument; the `NodeProgress` and `RunStalled` variants in Node's key order; `LastTool`.
- `crates/workflow/src/quota_resume.rs`: `QuotaAutoResume` (`on_run_settled`, `scan`, `dispose`), the port `QuotaResumePort` (`get_run`, `list_session_runs`, `resume`) and the pure rule `quota_resume_at`. The Node constants are kept: margin one minute, spacing ten minutes doubling to one hour, two transient retries, the transient refusal `already_running`, and a scan of 64 runs.
- `crates/workflow/src/test_clock.rs` (test only): `AdvancingClock`, a `RedriveClock` the test moves by hand. Jobs run when the test advances past their delay, and a refusing mode stands in for a failed spawn.

**The rules.**

Stall clock:

- A success (`model_request_completed`) resets the clock, clears the counted reasons and the notified flag, and cancels the armed timer.
- A retry (`model_retry_scheduled`) counts its reason and arms the timer for "last success plus twenty minutes" when none is armed. A retry inside a period that has already notified is not counted.
- At the window, with no success since and at least one counted retry, the notice fires once for the period: `run-stalled {sinceMs, reason, cap}`. The reason is the most frequent one, the first seen on a tie. `cap` is the last cap the run saw, when it has seen one. With no counted retry nothing fires.
- A timer that wakes early re-arms for the rest of the window.
- The notice never stops the run. Settlement disposes the clock, so nothing is recorded after `run-settled`.

Quota timer:

- A row arms the timer only when it is `stopped(provider)`, `providerStop.kind` is `quota` and `resetAt` is set. The timer is due at `resetAt + 1 min`, or later when the spacing rule below applies.
- When the timer fires it reads the row again. It resumes only if the row is still that quota stop at that reset time. A row with another reset time re-arms at that time. Any other row (resumed by hand, superseded, stopped elsewhere) does nothing.
- No loop: once a run has auto-resumed for a reset time in this process, a later row with the same or an earlier reset time arms nothing (`not_advancing`).
- Spacing: the next auto-resume of a run starts no earlier than ten minutes after its previous start, doubling with each resume, at most one hour.
- A transient refusal (`already_running`) or a thrown resume is retried one margin later, at most twice, and each retry reads the row again. Any other refusal is logged and not retried. After the last retry the module logs `gave_up`, and the row is still a quota stop for a later scan.
- A failed journal read ends that attempt without resuming. Nothing escapes a timer job.
- `dispose` cancels every timer. A job that fires after it does nothing.
- The session scan at open resumes the due stops at once and arms the rest.

**Tests (red, then green).**

- Red: the new modules were added as `todo!()` stubs and the tests written against them. `cargo test -p rust-cli-workflow --lib -- stall_clock_tests quota_resume_tests driver_stall_quota_tests`: 31 tests, 29 failed, 2 passed. The two that passed check values the stubs already gave (the twenty-minute constant, and "no retry armed, no timer"), so they are not evidence of behaviour.
- Green, after the implementation: the same filter passes 31 of 31 (`stall_clock_tests` 10, `quota_resume_tests` 14, `driver_stall_quota_tests` 7). The crate's lib tests pass 334 of 334 (the 303 existing plus the 31). `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --locked -- -D warnings` are clean.
- Review round (ocr on 618c09545, ten findings, nine fixed in code and one staging note). New tests, red first: `quota_resume_tests` gains 8. Two are race tests (a dispose, and a settle, between a timer's row read and its resume), which failed before the fix: the timer resumed anyway. Six pin behaviour that already held and that the Node test file names (a retry that finds the run started meanwhile; a pending retry withdrawn on a re-settle at the same reset time; a read that throws at fire time; a dispose while a resume is in flight) and the two re-arm conditions (a reset past the timer ceiling, and a row changed before the first wake). Delta review (ocr on 618c09545..ec37dc727, two low findings): a settle that lands after a timer took its slot still let the stale job record and resume. One test, `a_settle_after_the_timer_took_its_slot_leaves_one_resume_from_the_newer_timer`, uses a test-only hook that runs after the slot is taken; it failed before the fix (the stale job resumed at the old time) and passes after. The recording checks for a newer timer in the same critical section, and the mismatch re-arm path checks too. The two `scheduled` log calls are merged into one, with an optional `spaced_until`. After the fix: crate lib tests 343 of 343. (The earlier figure, 342, was before this round.)

After the fix in the first review round: crate lib tests 342 of 342. The timer now checks its generation again under the lock after the row read, and disposal again before it records state and resumes. Refusals are a typed enum (`Refusal`). A failed clock schedule is logged as `dynamic_workflow.quota_resume.schedule_failed`, separate from a port refusal. `scheduled` and `retry_scheduled` are logged only when the job is armed, and a spaced start carries `spaced_until`. The owner counts an ask's turns inside the stats match. Finding 3 (nothing in production constructs `QuotaAutoResume`) is W7 staging, recorded in the W7 list below and on the type.

- Three test-side corrections came after the first green run, with no change to the behaviour under test: the scan test must put its rows in the port's journal map as well as its listing; the disposed-clock test asserts the pending count the clock really has; the settled-run test expects that no handle is left to post (`MailboxError::Closed`), not a served request.
- Section 8 item 10: `driver_stall_quota_tests::a_scripted_quota_failure_is_resumed_once_by_the_timer_at_its_reset_plus_one_minute` runs a quota failure through the real owner. The provider text names the reset in Beijing time. The run stops, the test reads the run's journal row, and the timer resumes it exactly once at reset plus one minute. This is the part of item 10 that runs without W7. The desktop E2E (the gate, the run service, a fake provider process) needs W7 and W9, so it is listed below, not faked here.

**Node divergences (continued from 9.13).**

35. The stall clock is attached with the redrive wiring, as the redrive clock is (divergence 30). With no clock attached it is inert and records no notice. W7 attaches it.
36. Node's observer feeds `noteSuccess` and `noteRetryScheduled` from each actor session's network status events. Rust has no such observer yet, so `model_request_completed` and `model_retry_scheduled` are owner methods that W7 calls from the child session's events. The driver's own transient redrive does not count as a retry, as in Node: Node counts only the runner's model retries.
37. A cancelled timer is a generation, not a removed timer. A job armed before a success still wakes at its window and posts a stale generation, which the owner ignores. The thread that sleeps for it (`ThreadClock`) lives until then. Node's `clearTimeout` releases it at once.
38. A refused job (the clock returns false) leaves nothing armed, and a later retry arms again. Node's `setTimeout` cannot refuse (as in divergence 31).
39. `lastTool` is not reported. `AskProgress.last_tool` exists and the owner passes `None`. Node takes the last tool the subagent started from its session's tool events, which W7 must supply. Until then `node-progress` has no `lastTool`. `turn` is the owner's count of `ask_stats` reports, one per resolved turn, so W7 must report once per resolved turn, as `reportTurnObservations` does.
40. `turn` counts across an ask's redrives, since Node's `turnsResolved` is per ask. `toolCalls` is the cumulative count with the redrive base (9.13, finding 9).
41. The non-failure reasons are dropped in the owner, where Node drops them in its observer. The outcome is the same.
42. The stall notice does not bound a redrive, in Node or in Rust. 9.13 said that part 5 "bounds an unbounded redrive". That was wrong: the notice exists so the user can cancel. A transient redrive is bounded only by the user's cancel, and by the unrecognized streak for the codes it covers. Divergences 23 and 24 stand: a stop never arms the clock, and the non-failure retries are excluded (divergence 41).
43. The resume is a blocking port call on the timer's thread. Node's resume is a promise the timer does not await. The port is called from that thread, so it must be `Send + Sync` and must not block the owner; W7 runs the resume on the run service's execution boundary. The module takes the run's timer slot under the lock after the row read, then, in one critical section with the recording, checks that the module is live and that no newer timer has been armed since the slot was taken. A settle that lands after the slot is taken arms a newer timer, which makes the stale job resume nothing (test `a_settle_after_the_timer_took_its_slot_leaves_one_resume_from_the_newer_timer`). What remains is the window between that check and the port call: a dispose there can still let one resume start, as an in-flight Node resume can. The lock cannot be held across the call, since the port may re-enter the module.
44. A refused job for the quota timer leaves no timer for that run. A later settlement or a session scan arms it again. Node cannot refuse a timer.
45. Node's refusal reasons are a typed enum here (`Refusal::AlreadyRunning`, and `Refusal::Other` for every other reason, by Node's name). The transient set has one value, `already_running`. Every other refusal is logged and not retried, as in Node.
46. The `setTimeout` ceiling (about 24.8 days) is kept, so a reset a month away wakes, re-reads the row and re-arms, as Node does. `ThreadClock` has no ceiling, so the cap is for parity only.

**What W7 must wire (and W9 for the E2E).**

- [Done in W7-3, 9.20: `workflow_assembly::attach_run` attaches `ThreadClock`.] Attach the production clock for every actor run: `attach_redrive(handle, Arc::new(ThreadClock))`. Without it the stall clock is inert, and a transient failure fails its ask with `DriverError` (divergence 30).
- [Partly done in W7-3, 9.20: the owner routes the feed and `AskObserver` posts it. The subscription to the child's stream is W7-5.] Feed the owner from the actor sessions: `model_request_completed()` for each completed request (the child session's `ModelRequestCompleted`), `model_retry_scheduled(reason)` for each retry status, and `AskProgress.last_tool` from the actor's tool-started events. Report `ask_stats` once per resolved turn.
- [Open after W7-3.] Staging: no production code constructs `QuotaAutoResume` yet. W7 constructs one per session with its port and the production clock, and wires its `on_run_settled`, `scan` and `dispose` calls.
- Implement `QuotaResumePort` over the run journal and the session's run list (limit 64). `resume` goes through the session's execution boundary, as the app's Resume does, and then re-arms tracking; refusals map to `ResumeAnswer::Refused` with Node's reason text. The port must be `Send + Sync`. Call `QuotaAutoResume::on_run_settled` when a run settles, `scan` when the parent session opens, and `dispose` before the run service closes.
- The scripted-provider desktop E2E of section 8 item 10 (gate on, run service, fake provider process) is W9, after the gate flips. The driver-level test in this part covers the rule without it.

### 9.15 W6b part 6: LiveRunGuard, residency and the close chain (as built)

Scope: the guard and the residency rules, the session close port, and the dispose rules of the driver (Node driver tests rows 31 to 36). What is left for the run service (W7) is listed at the end.

**Where it lives.**

- `crates/workflow/src/residency.rs`: `SessionResidency` (the process ledger), `LiveRunGuard` (one live run; dropping it is the run's settlement) and the `LiveRun` port (`stop_interrupted`).
- `crates/workflow/src/driver_owner.rs`: `ActorSessions::close_session` (the close port); `ActorPort`'s `WorkflowDriver::dispose` (once per settlement, each session closed once, failures recorded); the refusal of a session after dispose; `ActorDriverOwner::attach_residency` (the launch registration). The owner releases the guard in `pump` at settlement, next to the governor link.
- `crates/workflow/src/actor_sessions.rs`: `ActorTurns::close_session`; `NodeActorSessions` forwards it to the turn side.
- `crates/workflow/src/actor_turns.rs`: `SessionCloser` (the runtime's close; `NoCloser` is the default), `MailboxTurns::with_closer`, and the turn side's ledger (`TurnLedger`, `TurnGuard`). A close asked while a turn runs is held, and runs on the thread of the session's last turn.
- Tests: `residency_tests.rs` (10), `driver_close_tests.rs` (6, rows 31 to 36), `actor_turns_close_tests.rs` (4, the turn-side cases of rows 31, 32, 34 and 35). Test doubles that gained `close_session`: `driver_owner_tests::Recording`, `actor_sessions_tests::Turns`, `actor_turns_tests::TestSessions`, and the runtime's `Sessions` in `crates/runtime/src/actor_turns_tests.rs`.

**The eviction path in `crates/session` (checked).** Rust has no idle eviction. The only removal of an open session is an explicit close. `runtime/src/table.rs` (`Closer`) moves the slot from Open to Closing when the close starts (`closing`), and clears the per-session state and removes the slot when the close is done (`released`), after the session's actor has exited. Deletion (`protocol-zcode/src/fork/session_tree.rs`, `session_deletion.rs`) closes idle runtimes; it asks `residency_busy` (a running turn, a pending interaction, a queue) first. No path consults a run's guard today. The guard rule is enforced by the ledger, so W7 must put the ledger on these paths (see below). Node's idle deactivation (`session-idle-deactivation.md`, `hasResidencyBlockingWork`) has no Rust counterpart.

**Rules.**

1. A live guard blocks eviction. `try_evict` refuses while any guard is held on the session.
2. Each run holds one guard on its parent session, from the launch (`attach_residency`) to its settlement. A run that has already settled takes no guard. A run with no parent session is refused, since nothing would keep it resident.
3. `SessionResidency::close(session)` refuses new guards on the session, calls `stop_interrupted` on every live run that has not been stopped yet (outside the ledger's lock, since a stop may settle the run at once), and waits on a condition variable until every guard has been dropped. The wait is bounded (`DEFAULT_CLOSE_WAIT`, 60 seconds, or `with_close_wait`). A close that cannot finish returns an error naming the session and the runs still live. An idle session returns at once and stops nothing.
   3a. A run is stopped at most once, whatever the number of closes: the ledger marks each guard as stopped under its lock. A stop cannot close its own session: a close requested from inside `stop_interrupted` on the same thread is refused at once, with a thread-local flag.
4. A closed or evicted session refuses a new guard. A launch after close is a wiring error.
5. Settlement: the engine calls the driver's `dispose` once per settlement (`finish_run`). Each session the run created is handed to the close port once, in session-id order (`disposed` makes it run once per driver). The owner does not wait. The turn side holds the close while the session's turn runs, and closes it on the thread of the last turn. Once a close is requested, `start_turn` refuses the session ("is closing"): a turn begun after the request would outlive the close.
   5a. A refused close leaves the session's request, so a later close request tries again. This holds for an idle close (returned to the caller) and for a deferred close (recorded in the turn side's failure ledger, which the owner drains).
6. A disposed driver refuses a new session with `Workflow driver is closed`, and creates nothing.
7. A failed close does not fail the settlement. The owner records it in `close_failures` as (session, message) and logs `dynamic_workflow.actor_runtime.close_failed` with the session id. The messages keep the anyhow chain (`{:#}`). `ActorDriverOwner::take_close_failures` is the read point: it drains the port's failures, then the deferred ones the turn side recorded. On the turn side, an idle close's error is returned to the caller; a deferred close's error goes to the failure ledger and a warning.
8. `MailboxTurns::new` has no closer, and its close is an error ("no runtime closer is wired"), never a silent success. Production uses `with_closer`.

**Red, then green.** Recorded in this order.

- Compile, before any behaviour: `file not found for module residency`; `no SessionCloser in actor_turns`; `method close_session is not a member of trait ActorTurns` (actor_sessions_tests) and of `ActorSessions` (actor_turns_tests, driver_owner_tests). After the API was stubbed, `LiveRunGuard` needed `Debug` (`expect_err`).
- With inert bodies: 17 failed and 3 passed. The three that passed are the idle close, a close that does not wait for another session's runs, and a run that settled before attaching. Their bodies hold without any behaviour, so they stay as regression tests of their rules and are not evidence of the feature. Of the 17, the six owner tests failed on the harness (`session_of` was None before any ask, so the rows had no session); they were fixed by asking and draining first, and then failed on their assertions (`closed` empty; row 33 created `sess_2` after dispose; row 35 recorded no failure).
- Green: the 20 new tests (residency 10, owner rows 6, turn side 4) pass.

**Review round (ocr on #570, ten findings).** Each behaviour change had a red test first. Recorded in order: (a) the compile red for the new API (`no function or associated item named with_close_wait`, `no method named take_close_failures` on `MailboxTurns`, `ActorDriverOwner`); (b) with inert stubs, the turn-side and owner tests failed on their assertions: a refused close could not be requested again (closer called once), `start_turn` on a closing session succeeded, `MailboxTurns::new` closed silently, and the row 35 cause read `runtime close failed` without `close refused`; (c) the three bounded-wait residency tests hung on the unbounded stub (killed by a 120-second timeout). After the fixes all 370 pass. Findings: 1 retry after refusal (rule 5a); 2 deferred failure ledger (rule 7); 3 start refused while closing (`start_turn` invariant); 4 bounded wait with a named error (rule 3); 5 stop at most once and no re-entrant close (rule 3a); 6 `NodeActorSessions::close_session` delegation asserted in the existing delegation test; 7 `MailboxTurns::new` refuses to close (rule 8); 8 `ActorDriverOwner::take_close_failures` (rule 7); 9 the owner's `closed` set dropped (the `disposed` flag already guarantees once; row 34 still passes); 10 `{:#}` keeps the chain (rule 7).

**Test counts.** `cargo test -p rust-cli-workflow --lib --locked`: 370 passed, 0 failed (343 before this part, plus 27: 20 for the part and 7 from the review round). `cargo test -p rust-cli-runtime --lib --locked`: 159 passed (the runtime test double changed, no new test). `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --locked -- -D warnings` are clean.

**Node divergences (continued from 9.14).**

76. Row 32 is split. The owner hands the session over at once after the settlement cancels its turn, the way Node's `dispose` returns synchronously. The wait is on the turn side: the runtime close is held until the ask's thread ends. A Rust "turn" is the life of an ask's thread, so the nudged turns of one ask count as one.
77. Row 33 is a refusal only. Rust's `create_actor_session` runs on the owner's thread, and `dispose` runs on the same thread, so no late instance can exist. Node's release of a late instance (its `catch` in `createActorSession`) has no counterpart.
78. Row 34's once-rule: the owner's `disposed` flag runs the dispose loop once per driver, and the turn side's `requested` set makes a second close request a no-op. The owner keeps no set of its own (the review round dropped it as dead state).
79. Row 35: an idle close's error is returned by the turn side and recorded by the owner. A deferred close's error is only logged, on the ask thread, since there is no caller left. Node logs both cases.
80. Row 36: the GC half is not carried. Rust has no GC-collectable runtime check; a runtime is released when its last owner drops it.
81. Sessions are closed in session-id order. Node closes them in map order.
82. The quiescence ledger (Node `workflow-driver-quiescence.ts`: `noteDisposed`, `quietSessions`, the bounded wait that amend uses) is not ported. Node's dispose records each session's in-flight turn into it. Amend's continuation is not ported yet (W5b), so nothing reads it.
83. The residency ledger is a counted record of live runs per session, not a callback into a residency pool. Node's `hasResidencyBlockingWork` poll does not exist here. `SessionResidency::close` blocks on a condition variable, so an async caller must run it on the blocking pool (W7).
84. The guard is the only residency fact. Node's pool also counts a session's own in-flight requests (`residencyFinalizationCount`). Rust has no idle eviction, so there is no caller that needs that count yet.

**What W7 must wire.**

1. [Done in W7-3, 9.20: `actor_mailbox::MailboxRun`.] A `LiveRun` for each run. `stop_interrupted` posts a stop to the owner's mailbox, and the owner's thread calls `engine.stop(Interrupted)`. Without it, `SessionResidency::close` waits on a live run that nothing stops.
2. [Done in W7-3, 9.20: `workflow_assembly::attach_run`; the launch itself is W7-5.] The launch calls `ActorDriverOwner::attach_residency(&residency, run)` in the same synchronous step as the launch (Node's invariant 6), with one process-wide `SessionResidency` shared with the session table. A failed attach fails the launch before any run starts.
3. [Done in W7-3, 9.20: `AgentSessionCloser` and `workflow_assembly::actor_turns`; the agents release is the live entry only, divergence 71.] A production `SessionCloser` over the agents' child session (Node `closeBrowserSession`: `beginShutdown`, release of the node_repl session, then the browser session close), passed to `MailboxTurns::with_closer`. There is no production `ActorSessions` yet (`NodeActorSessions` is built only in tests), so W7 also builds the production assembly.
4. **Done in W7-6** (see 9.21). The session close path (`runtime/src/table.rs` `Closer::closing`): call `SessionResidency::close(session)` on the blocking pool, and keep the session retired while it closes. Deletion (`session_deletion.rs`) treats a session with a live guard as busy, in `residency_busy` or next to it. The close is not awaited by the session close (divergence 60).
5. **Partly done in W7-6.** Rust has no idle eviction, so no caller exists to call `try_evict`. The ledger rule holds (tested), and the table holds the one ledger, so a future evictor reaches it. Nothing in the tree evicts yet (divergence 63).
6. **Done in W7-6** (see 9.21; a bounded drain of every session with a live run, at the app's shutdown). An owner dropped before its run settles never runs `dispose`, so its runtimes stay open. Shutdown must stop and settle every live run first. The stop itself is each run's `stop_interrupted`, which is W7's to implement.
7. Settlement is the only dispose point (the engine's `finish_run`). The run service does not call `dispose` itself.

### 9.16 W7-0: incremental reducer (as built)

Status: built on `feat/rust-workflow-incremental-reducer-w7-0`, from `origin/fork` (ddee7f6fc). The gate stays off. Nothing outside `node-store` calls the new holder yet; W7-5 (the run service) feeds it.

**Where it lives** (`packages/rust-cli/crates/node-store/src/workflow_runs/`):

- `mod.rs`: `reduce(state: &mut State, envelope, limits) -> Option<Vec<Value>>`. It mutates the state in place and returns the delta ops that `delta::diff(prior, state)` would return. On `None` (a no-op) the state is untouched.
- `delta.rs`: `diff` (now the test oracle; the production path no longer calls it), and `RunDiff`, `diff_run`, `removed_op` and `whole_key`. The reducer and `diff` share the last three, so key order cannot drift between them.
- `js.rs`: `obj_equal`, the no-op check on two run objects without wrapping them in a `Value`.
- `projection.rs`: `LiveProjection` (`new`, `from_state`, `state`, `snapshot`, `apply`), the per-session holder. `on_progress` is removed; its only caller was the test.
- `replay.rs`: `replay_state` folds in place and still returns `None` when no envelope changed anything.
- `publish.rs` (new): `clamp_for_legacy`, `encode_for_legacy`, `growth_upper_bound`, `LEGACY_MAX_ENTRIES` (256), `ENVELOPE_SLACK_BYTES` (64). Pure ports of Node's `workflow-runs-legacy.ts` and the two rules in `conversation-workflow-run-deltas.ts`.

**Rules.**

1. A no-op (an invalid envelope, or a replay with identical content) returns `None`, leaves the state byte-identical, and bumps no revision.
2. Only the run the event touches is cloned and diffed. Eviction (the entry budget and the run-count cut) removes whole runs and never edits a survivor, so the other runs need no diff. The ops are, in order: one `workflowRun.removed` per run whose id vanished, in prior order, carrying the new revision; then the event run's op (birth, or `diff_run` against the run as it was). If that op is `WholeKey`, the result is the whole key alone. If the op list is empty after a real change, the result is the whole key. This is exactly `diff`'s ordering and fallbacks.
3. The run-count cut stays at `PRODUCTION.max_runs` (8). The entry budget comes from `limits`.
4. `LiveProjection` takes its deltas from `reduce`. It never calls `diff`.
5. Legacy encoding (`encode_for_legacy`): a batch with no run delta is returned as the same slice (`Cow::Borrowed`). Otherwise every run delta is dropped and one whole-key `state.updated{workflowRuns}` goes at the position of the last dropped op, carrying the clamped current state. With no state, the deltas are dropped and nothing is inserted.
6. Growth bound (`growth_upper_bound`): the byte length of the batch plus 64, when every op is `workflowRun.updated` or `workflowRun.removed`. Otherwise `None`. A whole-key patch is never on the fast path.

**Tests.** Red first, then green. The red change is the new API in the tests: `reduce` takes `&mut State` and returns the ops, the goldens and the property test compare the returned ops with the Node ops string and with `diff`, the no-op byte-identity checks, a pointer-identity test that another run's buffer survives an event, `LiveProjection`, and the ported Node cases.

- Red: `cargo test -p rust-cli-node-store --lib --no-run` failed to compile with 28 errors: 25 `E0308` (the old `reduce(Option<&State>) -> Option<State>` signature), `E0432` for `projection::LiveProjection`, `E0432` for `publish`, and one `E0277` (`for op in &ops` over an `Option`).
- Green: `cargo test -p rust-cli-node-store --lib workflow_runs`: 29 passed, 0 failed. The count was 16 `#[test]` functions at `origin/fork`; 13 are new. The full `rust-cli-node-store` run: 348 passed, 0 failed, 1 ignored. `cargo fmt --all --check` is clean, and `cargo clippy --workspace --all-targets --locked -- -D warnings` is clean.
- Goldens: `fixtures/workflow-runs/goldens.json` is unchanged. The golden test now compares the ops that `reduce` returns, which are checked byte for byte against Node's, and the property test reproduces the next state from the returned ops.

**Node tests ported.** `apps/zcode-cli/packages/bootstrap/tests/conversation-workflow-run-deltas.test.ts`, all nine cases:

| Node case                                                                                 | Rust test                                                                           |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| legacy: a batch with no key-level delta comes back as the same array                      | `a_batch_without_run_deltas_comes_back_as_the_same_slice`                           |
| legacy: a batch of run deltas folds into one whole-key patch at the last dropped position | `a_batch_of_run_deltas_folds_into_one_whole_key_patch_at_the_last_dropped_position` |
| legacy: a table over 256 is cut to 256 and marked `truncated`                             | `an_over_legacy_table_is_cut_to_256_and_marked_truncated`                           |
| legacy: no `workflowRuns` key means the deltas are dropped and nothing is inserted        | `without_a_workflow_runs_key_the_run_deltas_are_dropped_and_nothing_is_inserted`    |
| growth: an all-key-level batch has a bound above its own bytes                            | `an_all_key_level_batch_has_a_growth_bound_above_its_own_bytes`                     |
| growth: any other op forces an exact measurement                                          | `any_other_op_in_the_batch_forces_an_exact_measurement`                             |
| growth: an empty batch takes the fast path with room for a wider `seq`                    | `an_empty_batch_takes_the_fast_path_with_room_for_a_wider_seq`                      |
| growth: a whole-key `workflowRuns` patch is never on the fast path                        | `a_whole_key_workflow_runs_patch_is_never_on_the_fast_path`                         |
| growth: the eviction stream is key-level at every step and within the bound               | `node_eviction_stream_every_step_is_key_level_and_within_the_growth_bound`          |

Also added, with no Node counterpart: `a_state_within_the_legacy_bound_is_returned_as_it_is` (the Node "same object" rule), `an_event_for_one_run_does_not_rebuild_the_other_runs`, `live_projection_deltas_keep_a_consumer_equal_to_the_holder` (the entry budget, and ten runs for the run-count cut), and `a_live_projection_seeded_from_replay_continues_the_fold`.

Not ported here. Four other Node tests use `reduceWorkflowRunsState` only as a fold inside larger scenarios: `dynamic-workflow-run-service.test.ts`, `dynamic-workflow-run-roster.test.ts`, `dynamic-workflow-report-reads.test.ts`, and `dynamic-workflow-run-replay.test.ts`. Their assertions are about the run service, the roster, report reads and the cold replay as a whole. The run service, roster and reads are W7 and W9 surfaces; the cold replay is section 9.4. Their reducer calls are not separately ported.

Also not ported, with owner W7-5 (the Host publisher). `conversation-topic-publisher-workflow-runs.test.ts` drives `ConversationTopicPublisher`, the subscription registry, the retained log and `ProductProjection`, so it needs the publisher shell first. Coalescing is not ported: `mergeWorkflowRunUpdates` and `workflowRunUpdateWithinWireBounds` (`workflow-runs-delta.ts`) stay with the publisher. `publish.rs` ports only the two per-batch rules (`encodeConversationDeltasForLegacy` and `workflowRunDeltaGrowthUpperBound`). Section 9.8i rows 58 (the escalation payload clip at 2048 characters) and 65 (raised and resolved on the live track and in event paging) stay open with owner W7-5. `LiveProjection` adds neither the clip nor the event paging.

**Divergences.**

1. The signature changed. Node's reducer returns a new state. The Rust reducer returns the ops and mutates the state. A caller that needs the prior value clones it first.
2. Cost per event is one clone of the affected run, which the reducer rebuilds, plus a comparison against the stored run without a clone. The other runs are untouched; the pointer test pins that. A reducer that edits the affected run in place would need the table functions to take `&mut Obj`, which this part does not do.
3. `LEGACY_MAX_ENTRIES` is a local constant equal to Node's `WORKFLOW_RUNS_LEGACY_LIMITS.maxActors` and `maxNodes` (256). There is no shared port of that constant yet. W7-5 should read this one.
4. Byte lengths are the compact `serde_json` text. That matches `JSON.stringify` for these ops, which hold integers and strings only. Non-integer floats are not checked.
5. Node's `workflowRuns` being `undefined` is `None` in Rust. A `LiveProjection` always holds a state, so the Host passes `None` only when no holder exists.
6. The growth bound and the legacy encoder are pure functions. The Host wiring and the 16 MiB gate are W7-5, not this part.
7. The count in section 9.4 said 14 `workflow_runs` tests. `origin/fork` had 16 `#[test]` functions in `tests.rs`. The count is now 31.
8. The seed is normalised in `LiveProjection::from_state`: at most `max_runs` runs, each with a unique string `runId` (the first occurrence wins; the most recent runs are kept, as the run-count cut keeps them). `reduce` now documents this precondition. Red first: `a_seed_over_the_run_limit_is_brought_within_it_before_the_first_event` and `a_seed_run_without_a_string_run_id_is_dropped_before_the_first_event` failed against the un-normalised holder (an over-limit seed kept 10 runs; an id-less run survived). Both compare the next event's ops with `diff`. Green after the fix. The full `rust-cli-node-store` run is then 350 passed, 1 ignored.

### 9.17 W7-2: helper format and window display (as built)

Status: built on branch `feat/rust-workflow-helper-format-w7-2`, cut from `origin/fork` (ddee7f6fc). Gate off: nothing calls these from a turn. Decision Q6 = (b): the text and the window come from the helper.

**How the text is reused.** The formatters and the window display live in `core/src/tool/handlers/`, and only `builtInTools` is exported from the core index. Nothing re-implements them: the helper finds Node's own tool entries in `builtInTools` by name and calls them. `listWorkflowRunsToolEntry` and `getWorkflowRunToolEntry` run their handler on a stub run port that returns the port data Rust sent, then their `formatModelContent`. The window display is `createWorkflowToolEntry.prepareApproval({script})`, the same `displayOfAnalysis` path the confirmation dialog uses. Exporting the formatters from core would have been the other route; it touches core, which W7-2 does not, so it is not done here.

**Correction to the brief's wording.** The GetWorkflowRun text does not carry graph bounds or fold. Its `<summary>` is built by Node's handler (`buildWorkflowRunSummary`), which `runDetail` reaches through the entry. The causal graph bounds (`boundCausalityGraph`) and the phase fold (`foldPhaseEdges`) are part of the window display, through `displayOfAnalysis`.

**Helper wire** (`helper/workflow/format`, `workflow-protocol.ts`, a discriminated union on `kind`; any other kind is -32602):

- `analysis` (W4, unchanged): `{scriptText}` returns `{analysis}`.
- `display` (W7-2): `{scriptText, modelBindings?}` returns `{display}`, the CreateWorkflow window, or `{display: null}` when Node opens no window (the script does not analyze, or a script that names a model has no binding for it). `modelBindings` is the script's model table as `resolveInput` writes it (`model_bindings`); Node opens the window for a model-naming script only with it.
- `runList` (W7-2): `{input, listed, workingDirectory}` returns `{text}`. `input` is parsed by Node's ListWorkflowRuns input schema (a bad query is -32602). `listed` must have a `runs` array; `truncated` is optional.
- `runDetail` (W7-2): `{runId, detail, workingDirectory}` returns `{text}`. `detail` is the run port's `DynamicWorkflowRunDetail`, or `null` for an unknown run; the text is then Node's not-found failure message. The members Node dereferences without a guard are pinned (`runId`, `label`, `labelSource`, `status`, `ownedByThisSession`, `createdAt`, `updatedAt`, `usage`, `actors`, `logTail`, `subagents`, `health`), so drift is -32602.

The helper is stateless: it reads no storage, session or journal.

**Not done: `helper/workflow/evalSnippet`.** Whether a snippet may do workspace I/O is an open user decision (section 10). No method is added, and the text is not invented.

**Rust client** (`protocol-zcode/src/fork/workflow_compile.rs`): `display`, `run_list_text` and `run_detail_text` send the requests above over the existing `FORMAT` method and parse the replies strictly (`display` must be an object or null; `text` must be a string). The request builders are `run_list_params` and `run_detail_params`.

**Tests.**

- Helper (`bootstrap/tests/fork-rust-helper/workflow-compile.test.ts`, already in `scripts/fork-test-files.json`). Five new cases: the run list and run detail equal Node's handler and formatter on the same input (run under fake timers, so the ages are fixed); the window equals `prepareApproval`; a non-analysing script answers `display: null`; a `runList` without `listed` is -32602. The red run before the implementation: four failing (the list, detail, display and null cases, all -32602), and the detail case first failed in the fixture until `health` was added. Green after: the file is 12 of 12, and the whole `tests/fork-rust-helper` set is 16 files and 133 tests.
- Rust (`workflow_compile_tests.rs`): five new cases for the reply parsers and the request builders. Protocol-zcode is 913 of 913 green, and clippy `-D warnings` is clean. The Rust tests were written with the functions, not before them, so no Rust red run was recorded.

**Gap.** The client is not round-tripped through `NodeHelper::forward` with the fake helper. The fake helper rig is private to `node_helper_tests.rs`, which is outside W7-2's file list. The round trip belongs with the run service (W7 proper) or in a follow-up that may touch that file.

**Errors.** The `runList` input is parsed with Node's own schema before the handler runs, so a bad query is -32602. Drift in `listed` or `detail` is -32602 from the params schema, so the formatter never sees it.

**ocr review round 1 on PR #571 (fixed).** HIGH: `display` dropped the model bindings, so every script that names a model got no window; now `modelBindings` is threaded through. MEDIUM: an unknown run was refused by the schema, so Node's not-found text was unreachable; `detail` is now nullable. LOW: unguarded members are pinned, so drift is -32602 and not a TypeError.

**Left for the run service (W7 proper).** The Rust run service must build `listed` from its list port and `detail` from its detail port, and call these methods on the GetWorkflowRun and ListWorkflowRuns paths. Until it does, the window and the text have no caller.

### 9.18 W7: decisions, PR split and W7-1 (as built)

**Decisions (binding, from the user).**

1. The run service lives in `runtime`, and reaches compile and spawn through `kernel-api` ports. `ChildHandler` moves to `kernel-api` in W7-5. The port is designed for that move: W7-1 adds no reference to `ChildHandler`.
2. World reads go through an argv mode in kernel-api `StartCommand`.
3. Orphan reconciliation moves into W7-5 (it was listed under W8).
4. `EvalWorkflowSnippet` runs in the Rust engine with an in-memory journal and the same world ports. The helper stays I/O-free.

The W7 estimate is about 21,000 lines (it was 2,500). The W6b parts 2b, 3, 5 and 6 are dependencies of W7.

**PR split.** W7-0 reducer; W7-1 scaffold (this section); W7-2 helper format; W7-3 adapters; W7-4 world ports; W7-6 lifecycle; W7-5 run service core; W7-7 control; W7-8a CreateWorkflow; W7-8b Save, List and EvalSnippet; W7-9 run tools; W7-10 Amend and Fill.

**W7-1 as built (scaffold, gate off).** Nothing is registered and the gate stays off. Each piece below is tested with stub tools or pure functions.

- Port trait: `kernel-api/src/workflow_run.rs`, `DynamicWorkflowRunPort`. The refusal codes are typed (`AmendRefusalReason`: `run_not_found`, `missing_boundaries`; `ResolveQuestionRefusalReason`: `unknown_question`, `already_resolved`, `run_not_in_flight`). Optional members default to `DynamicWorkflowRunError::unsupported`, the Rust form of Node's `typeof` probe. Submit, retune, the task waits, the artifact and workspace reads and the fill port are not in the trait yet (their PRs add them).
- Contracts: `scripts/fork-rust-agent/workflow-tools.mts` generates `crates/tools/assets/node_workflow_tools.json` from the ten Node handler entries. `pnpm rust-agent:workflow-tools:update` and `:check` mirror the cron generator; `:check` runs in `pr-checks.yml` next to the cron check. The asset is generated (471 lines), so the hand-written size of the PR is about 1,100 lines.
- Tools crate: `workflow_tools.rs` loads the contracts, `workflow_tools()` returns no tool, and the two predicates `is_amend_workflow_owned_predecessor` and `is_fill_workflow_hole_owned_run` port Node's `contracts/src/tools/*.ts` helpers.
- Gate filter: `runtime/src/workflow_gate.rs`, `GatedRegistry`, fed by `Extensions.dynamic_workflow` (a `DynamicWorkflowGates` source, implemented by `protocol-zcode`'s `Server`). `base_tools` wraps the registry when the source is set. `find_for` and `snapshot` show the workflow tools to a session whose record is open. `tools()`, `find()` and the other session-less views never show them. On-demand wraps each tool so that `should_defer` is true.
- Denylists: `agents/src/toolset.rs` holds `WORKFLOW_CHILD_DISALLOWED_TOOLS` (six), `RUN_INTROSPECTION_TOOLS` (two), `WorkflowTaskType` and `structural_workflow_disallowed`, the Node `resolveRuntimeDisallowedTools` structural part. The actor list is the existing `WORKFLOW_ACTOR_DISALLOWED_TOOLS` in `actor_turn.rs`, which matches Node's `ACTOR_DISALLOWED_TOOLS` in `bootstrap/src/app/workflow-actor-tools.ts` (seven entries, the same names). The denylist constants are `#[allow(dead_code)]` until a workflow child runtime reads them (W7-5).
- Missed routes (9.2): `commands::record_workflow_gate` is the one place a record is written from the create parameters and the Host's cached fact. The direct create route, the activation of a prepared session, the submission reservation, and legacy `session/resume` call it. The legacy `session/create` goes through the same `createSession` command and was already recorded.
- Tests (red first, then green): `tools::workflow_tools_tests` (5), `runtime::workflow_gate_tests` (6), `agents::toolset_tests::workflow_denylists` (4). The full suites of kernel-api, tools, runtime, agents and protocol-zcode pass; clippy `-D warnings` passes on those crates.

**Node divergences (new in W7-1, numbered from 52).**

52. A session with no gate record sees no workflow tool. Node reads an absent `dynamicWorkflowEnabled` on a protocol session as enabled, and it fails closed only in `appRuntimePreferences`. The Rust record is fail-closed at every layer (W1 `resolve_gate` and this filter), so the Host must send the flag for every session that should have the tools.
53. The session-less views (`tools()`, `find()`) never list or find a workflow tool. Node has one registry per runtime and no session-less view, so the split is structural: it keeps a tool from reaching a session whose gate is unknown.
54. On-demand defers every workflow tool for every on-demand session, and nothing activates it. Node's `dynamic-workflow-activation.ts` (DWG-09 and DWG-10) activates on the `/workflow` turn and on cold-recovery history, and persists an entry. Rust has none of that yet, so an on-demand session finds the tools only through ToolSearch. The activation port is a W7 follow-up, before the first tool registers.
55. The incognito `automationTools` exclusion (Node `resolveRuntimeDynamicWorkflowToolsIncluded`) is not in the gate yet. `IncognitoProfiles` is not reachable from `Server`, so the gate source cannot read it. This is a gap to close before any tool registers (W7-7 wires the source with the first tool).
56. `Extensions.dynamic_workflow` is set by no entry point. `Server` is built from a kernel that already holds the extensions, so a shared gate table, created before the kernel and held by both, is the wiring. It is inert in W7-1 because `workflow_tools()` returns nothing, and W7-7 adds it with the first tool.
57. The generated asset and the registration use Node's `handlers/index.ts` order (create, amend, save, eval, list runs, get run, resume, resolve, fill, list saved). The W1 constant `tool_names::DYNAMIC_WORKFLOW_TOOLS` keeps the W1 order (list saved after save). Tests compare the set, not the order of that constant.
58. The port trait carries JSON values for the snapshot, detail, list items and resume result, and the scaffold types only what the tools' inputs and refusals need. Each owning PR types its own fields. Model selections in an amendment stay `serde_json::Value` until W7-8a.

**Left out of W7-1.**

- `ChildHandler` (W7-5), the run service and the engine (W5a to W6b are already in their crates), the tools themselves (W7-7 to W7-10), and the helper format (W7-2).
- `prepare_worktree` (the worktree preparation that creates a prepared session) does not record a gate. Its session is the prepared one that the activation records before its first turn, so no tool is offered before the record exists. W7-7 confirms this.
- The incognito gate (divergence 55) and the shared gate table (divergence 56).

### 9.19 W7-4: production world ports and argv mode (as built)

Status: built on `feat/rust-workflow-world-ports-w7-4`, from `origin/fork`. Two commits: the argv mode (`12e96a7dd`) and the ports with their tests (`6db99235f`). Gate off; the ports have no caller yet (the run service is W7).

What is built:

1. **Argv mode on `StartCommand`** (kernel-api `env_command.rs`). A new optional field `argv: Option<CommandArgv { file, args }>`, serialized only when set (a shell-mode request keeps its wire form). `StartCommand::argv(file, args, cwd, task)` builds one; `command` holds the file as display text. env-local runs it with `Command::new(file).args(args)`: no shell, no script wrapper, stdin null, stdout in the output file and stderr in its own `.stderr` file (the watch already streams that file as `Stderr`). It refuses, with `EnvError::Unsupported`, any argv request that is not a foreground command with no `on_timeout`, not `CwdScope::Pinned`, or sandboxed. A missing program is a spawn error (`EnvError::Io` from `start`). The shell path is unchanged; the existing 67 env-local shell tests pass.
2. **The production ports** (env-local `world_ports.rs`; env-local now depends on `rust-cli-workflow`, which has no dependency on env-local). `WorldPorts` implements `WorldReadPorts` over `Search::glob`, `Files::read_file`, `Search::grep` and `Commands::start_command`. It blocks on a tokio handle, so it runs on a worker thread, as the owner's world jobs do. `WorldFs` implements `ArtifactFsPort` with `fs::metadata` before any open (a fifo is `NotFile` and is never opened), a read of at most `max_bytes + 1`, and `canonicalize` for the real path. `StoreAdapter` implements `ArtifactStorePort` over the kernel `ArtifactStore::put`, with purpose `Deliverable` and the receipt URI `zcode-artifact://<session>/<artifact>`.
3. **Run results.** A `Finished` event maps as Node does: exit 0 is `Completed`; a nonzero exit is `Failed` with no error; a timeout is `TimedOut`; an output limit or a wait failure is `Failed` with its text; a cancel is `Cancelled`. A program that cannot start is `Ok(SpawnError)`, not a port fault. Each stream keeps its head up to the inline limit, its full byte count, and the last `tail_bytes` when asked; the rest is counted and dropped.

Tests (all green in the final run; `cargo clippy -D warnings` clean for env-local, kernel-api, env-remote and exec-server; `cargo check --workspace --all-targets` clean):

- `shell_argv_tests.rs`: 6 cases (no shell expansion of literal arguments, stderr as its own stream, a nonzero exit, a missing program, refusal of a non-pinned request, and the serialized form with and without `argv`).
- `world_ports_tests.rs`: 30 cases (19 from the first pass; 11 added in the review round for the Node parity items above). Glob (absolute paths, total past the limit), read (exact text with the final newline), grep (line numbers, head limit flagged), run (argument pass-through, stderr apart, nonzero exit, spawn error, timeout, tail and inline limits), the four git reads through `execute_world_read` on a real `git init` in a subdirectory of a non-canonical temp path (`git-status` workspace-relative, `git-log` full hash, a non-repository a catchable `DriverError`), the publish containment cases on the real filesystem (a file inside, a symlink inside pointing outside refused, a symlink inside pointing inside published, a missing path and a directory source-missing, a fifo not a file), the fs port's bounds and faults, and the store adapter through a kernel store.

Red record. The argv tests were written after the argv code and passed on the first run, so they are not a red run. The world port tests were red first in two steps: the module did not exist (compile error), and then seven failures: six `there is no reactor running` (sync tests that needed a runtime handle, now `tokio::test`) and one git-status case that expected the untracked file by name. The second was a test-data error, not a port error: a directory with no tracked file is listed as one collapsed entry (`?` `sub/`), the same argv Node uses, so the fixture now tracks a file in `sub/`.

Review round (coordinator, PR #574). Each item was checked against Node's source on `origin/fork` before the verdict. Items that differed from Node were red first: seven tests failed before the port changed. Items that already matched got pinning tests that passed on the first run.

Node references are `apps/zcode-cli/packages/adapters/src/fs/index.ts` (`fs/index.ts`), `packages/adapters/src/fs/text-metadata.ts` (`text-metadata.ts`) and `packages/adapters/src/exec/output-collector.ts` (`output-collector.ts`).

Verdicts:

- **Grep head limit at the port (was div 3): matched.** Node reads every ripgrep match, then cuts with `applyHeadLimit` (`fs/index.ts:1822-1846`, `finishTextSearchResult` at `:1249-1275`). The port does the same: `WorldPorts::grep` reads all matches and cuts to `head_limit`, with `truncated` when more followed. Pinned by `grep_returns_content_matches_and_flags_the_head_limit`.
- **Grep text line ending (was div 4): matched.** Node drops one trailing `\r?\n` (`stripTrailingLineEnding`, `fs/index.ts:1351`, used at `:1207-1214`). Pinned by `grep_line_text_has_no_line_ending`.
- **Glob and grep options (was div 5): matched, with one fix.** Node `searchFiles` walks regular files, keeps hidden files, reads no ignore files, and skips version-control directories (`walkFiles`, `fs/index.ts:1719-1742`), then matches with `createGlobMatcher` (`:1744-1818`). The port now ports that matcher (`GlobMatcher`, `glob_regex`), trims the pattern and refuses an empty one (`fs/index.ts:403-410`), and skips version-control directories. Before the fix, `.git` contents were counted. Grep follows Node's ripgrep call (`--hidden`, ignore files read, VCS excluded: `fs/index.ts:936-953`), with the glob split as `splitRipgrepGlobPatterns` does (`:1008-1023`). Pinned by `glob_matches_the_basename...`, `glob_trims...`, `glob_keeps_hidden_files_and_skips_version_control_directories`, `grep_skips_version_control_directories` and `grep_splits_the_glob...`. Not compared: how ripgrep's ignore crate and the Rust `ignore` crate treat edge cases of their own ignore files, and binary-file handling. Those are the crates' own behaviour on each side.
- **Read decoding (was div 6): matched except legacy Chinese encodings.** Node `readTextFile` detects a UTF-8 or UTF-16LE byte order mark, refuses binary content (a NUL, or more than 30% control bytes) and bytes that are not UTF-8, and normalizes CRLF to LF (`text-metadata.ts:30-62`, `:105-115`, `:198-230`, `:232-250`; `fs/index.ts:157-199`). `decode_node_text` does the same, with Node's error text. Pinned by `read_normalizes_crlf_to_lf`, `read_keeps_a_utf8_byte_order_mark...`, `read_decodes_utf16le...` and `read_refuses_binary_and_invalid_utf8`. **Divergence 2 below**: Node also decodes `gb2312`, `gbk` and `gb18030` with iconv (`text-metadata.ts:30-49`, `:132-150`); there is no iconv equivalent in this workspace, so those files are refused.
- **Run truncation for discard and tail (was div 8): matched.** Node sets `truncated` only when a non-empty chunk does not fit the inline limit (`output-collector.ts`, `append`). With a limit of 0 that is `total > 0`, which is what the port does. Pinned by `discard_reports_truncated_only_when_output_was_dropped`.
- **Default timeout (was div 9): matched.** The workflow always passes a timeout for `world.run` (Node `WORLD_READ_CAPS.runDefaultTimeoutMs`), and the git reads pass the same value, so the port's own default is never used.

Review round 2 (ocr on 58f928b99, partial: some chunks did not finish). Verdicts:

- **1 env-remote silently dropped argv (MED): fixed.** `to_wire::start_command` now returns `EnvError::Unsupported` for argv, so the converter fails closed on its own. Test `the_wire_converter_refuses_argv_too_so_it_is_never_dropped`.
- **2 argv display text (LOW): fixed, Node has no guidance.** Node's only argv join is the Windows cmd shim (`execution-command.ts:244-250`). `CommandArgv::display` is a POSIX shell quoting of file and args; `command` holds it. Test `an_argv_payload_round_trips_and_a_legacy_payload_has_no_argv`.
- **3 remote refusal pinned through `RemoteEnvironment::start_command` (LOW): not done.** A `RemoteEnvironment` needs an `ExecClient`, which needs a completed handshake; the peer harness that makes one is `cfg(test)`-private inside exec-client. The refusal is pinned at the guard (`an_argv_command_is_refused_before_anything_is_sent`) and at the converter (test 1). Writing a handshake peer is a separate change.
- **4 `CommandArgv` re-export (LOW): fixed.** `crate::env` re-exports it.
- **5 operation and task ids collide across instances (MED): fixed.** The counter is process-wide (`NEXT_OPERATION`). Test `two_ports_in_one_process_never_share_an_operation_or_task_id`.
- **6 grep walks into `.git` (MED): fixed.** Grep now passes `!dir` and `!**/dir/**` for each VCS directory to the walk, as Node's `createRipgrepSearchPlan` does (`fs/index.ts:936-953`). The entry filter stays as a safety net. A walk exclusion is not observable from the result, so this has no red test of its own.
- **7 glob walk descends into `.git` (LOW): fixed in the environment.** `search::glob` prunes VCS directories as `list_files` does, matching Node's `walkFiles` (`fs/index.ts:1719-1742`). This also changes the Glob tool, which Node also gives no VCS entries. Test `glob_does_not_walk_version_control_directories`, red at 3 against an expected 1.
- **8 missing exit code counted as success (LOW): fixed.** `Completed` with no exit code is `Failed` with an error text. Test `run_status_treats_a_missing_exit_code_as_a_failure`.
- **9 unbounded `read_text` (MED): fixed, with a divergence.** Node's `readTextFile` in `files.read` has no size guard (`workflow-world-read.ts`, `worldRead`). The port adds one: a stat first, then a refusal over 16 MiB (`READ_TEXT_CAP_BYTES`, the run stream cap), and a byte-count check after the read. Test `a_text_read_over_the_cap_is_refused`. Divergence 8 below.
- **10 stat-then-open window (LOW): fixed, residual window documented.** The file is opened non-blocking (a fifo cannot block the open), and the opened file's own metadata is checked. Test `a_path_to_a_fifo_is_refused_without_blocking_the_read`. Residual: a path swapped between the stat and the open is judged by the opened inode, not by the path, so it cannot be read as the fifo, but the cap check runs on the stat before the open. Divergence 9 below.
- **11 argv with no shell wrote `SHELL=""` (LOW): fixed.** With no configured bash, the argv child keeps the snapshot's `SHELL` (`environ::project` gets `None`). The dead Background arm is gone. Test `argv_without_a_configured_shell_inherits_the_snapshot_shell`.
- **12 argv refusal tests (LOW): added.** `argv_refuses_a_sandbox_and_every_kind_but_a_plain_foreground_command`.
- **13 round-trip with argv Some (LOW): added.** The round-trip and the legacy-payload test are in kernel-api `env_shell_tests.rs`.

Red record for round 2: the new tests were written with their fixes in the same change for items 2, 4, 6, 10, 11 and 13. Items 1, 5, 7, 8 and 9 were red first (the glob pruning test was observed at 3 against 1; the id, status and cap tests failed to compile before the code existed). The shell `SHELL` test was not observed red.

Divergences that remain (numbered for this part):

1. **Remote machines refuse argv.** `RemoteEnvironment::start_command` refuses argv through `refuse_argv` (env-remote `ports.rs`) before anything is sent, and the converter `to_wire::start_command` refuses it too. Node's execution port runs argv on every machine (`workflow-world-read.ts`, `runGit` with `command.mode: "argv"`). The wire has no argv mode yet, so world reads on a remote machine fail until it does. Tested by `an_argv_command_is_refused_before_anything_is_sent` (the guard; the port method itself needs a connector that only exists in exec-client's test support).
2. **Legacy Chinese encodings are refused.** Node decodes `gb2312`, `gbk` and `gb18030` text with iconv (`text-metadata.ts:30-49`, `:132-150`, `:214-217`). The Rust port refuses any file that is not UTF-8 (`decode_node_text`), with Node's `unsupported` message. Matching needs a code-page table dependency; not done.
3. **Output goes through the shell's output file.** Node's collector keeps the inline head in memory and writes the rest to a file only when `persistOutput` asks (`output-collector.ts`, `append`). Here the shell always writes its output file, and the adapter reads the events back, keeping only the head, the tail and the count. The returned values are the same. The shell's own output cap applies.
4. **The store takes no tool-call id, retention or extension.** `ArtifactStore::put` has the session, purpose, media type and bytes. Node's store call also passes the tool-call id (the file name prefix), the retention and the file extension (`workflow-artifact-publish.ts`). They are not written. The purpose is `Deliverable`, a choice made here, not a Node port.
5. **Operation ids are process-local.** Each run is `world-<pid>-<n>` in the shell layer. The process id keeps two processes that share a scratch directory apart. The run and the site are not in the id. No returned value depends on it.
6. **Nothing constructs the ports yet.** `WorldPorts` and `StoreAdapter` are built by the run service (W7), which passes them to the owner's `WorldWiring`.
7. **No boundary checker in this checkout.** `scripts/rust-cli/check-boundaries.mjs` is not on `origin/fork`, so only the clippy disallowed-methods rules check file IO in env-local.
8. **`files.read` has a 16 MiB cap.** Node's `worldRead` calls `readTextFile({ path })` with no `maxBytes` (`workflow-world-read.ts`, `worldRead`), so Node reads any size. The port refuses over `READ_TEXT_CAP_BYTES` (16 MiB, the run stream cap) with a message that names the cap. A file between Node's unbounded read and this cap is read the same way.
9. **The fifo guard has a residual window.** `WorldFs::read_file` stats the path, opens it non-blocking, and judges the opened file's metadata. A path changed between the stat and the open is judged by the opened inode. The size check runs on the pre-open stat and again on the bytes read.
10. **The argv display text is not a Node format.** Node has no display text for argv (`execution-command.ts:244-250`). `CommandArgv::display` is a POSIX shell quoting, shown only and never run.

### 9.20 W7-3: production adapters for the workflow ports (as built)

Scope: the production side of what W6b left inert. The run service itself is W7-5, and it composes these pieces. The
module boundary is the W7 decision: the run service lives in `runtime` and reaches compile and spawn through the
`kernel-api` ports. The governor is a port the workflow crate names, its production adapter is in `cli`, and the caller
passes it in.

**Where it lives.**

- `crates/workflow/src/actor_feed.rs`: `FeedEvent` (wait, executing, retry, completed, last tool) and `AskFeed`, the
  observer's per-ask state. `AskFeed::notice` reads the runtime's `ModelNotice` stream. It is the Node
  `createActorModelActivity` rules that a Rust source can feed.
- `crates/workflow/src/driver_owner.rs`: `ActorDriverOwner::feed` routes each event to its engine call (`ask_waiting`,
  `ask_executing`, `model_retry_scheduled`, `model_request_completed`, and the ask's `last_tool`, which `ask_stats`
  carries on `node-progress`). `stop_interrupted` settles the run as `stopped(interrupted)`.
- `crates/workflow/src/actor_mailbox.rs`: `ActorRequest::Feed` and `StopInterrupted` (posted, no answer), `ActorHandle::feed`
  and `stop_interrupted`, and `MailboxRun`, the run's `LiveRun` over the mailbox (9.15 item 1).
- `crates/agents/src/actor_turn.rs`: `Agents::release_actor_session`, the agents part of the close. It removes the child's
  live entry, refuses a session with a turn running, and treats an unknown session as released.
- `crates/cli/src/frontends/workflow_governor.rs`: `GovernorRunConcurrency`, the production `RunConcurrency` over
  `model::governor::Governor`. `wire_reason` maps the controller's `ChangeReason` to Node's `ConcurrencyChangeReason`
  strings (`rate_limited`, `provider_overloaded`, `recovered`, `idle_reset`, `limit_lowered`, `seeded`). `governor_bound`
  floors at 1 and saturates to `u32`. The cli crate gains a dependency on `rust-cli-workflow`.
- `crates/runtime/src/workflow_assembly.rs` (new): `AgentSessionCloser` (the production `SessionCloser`), `actor_turns`
  (`MailboxTurns::with_closer`, since `MailboxTurns::new` refuses closes), `attach_run` (the launch's registrations in
  the order 9.15 item 2 gives), and `AskObserver` (the turn side's feed, which posts and does not wait).
- `crates/runtime/src/actor_turns.rs`: `ActorRunBase::for_run`. `crates/runtime/Cargo.toml` moves `anyhow` to the
  production dependencies, since the closer's signature needs it.

**The rules.**

- A wait is reported once per wait period. An identical wait is not reported again, and executing starts a new period
  (Node `reportWaiting` and `reportExecuting`). A retry with `reasoning_signature_repair` or `auth_refresh` produces
  nothing (Node drops them before any handler).
- A `Retrying` notice reports the retry's reason to the stall clock, then waits in backoff with `attempt` one more than
  the failed attempt, the delay, and the Retry-After of a rate limit. The reason is the policy table's
  (`facts_of`), except that an authentication rejection reads `auth_refresh` (divergence 80).
- `Resumed` is executing. `Stalled` reports nothing.
- `attach_run` runs in the order residency, governor, clock. A run with no parent session fails here, before anything is
  bound. The settlement releases the governor bound and the parent's guard. The redrive and stall clocks run on
  `ThreadClock`.
- The closer runs on the thread that closes: the ask thread (the last turn's), or the owner's. It never runs inside a
  runtime. A refusal is an error that the owner records as a close failure.

**Red, then green.** The observer tests (`actor_feed_tests`, 8) and the owner feed tests (`driver_feed_tests`, 8) were
written in the same pass as their code, and the first run passed. No separate red run was recorded for them, so the
claim of red first does not hold for this batch. The runtime assembly tests (5) and the governor adapter tests (4) were
fixed after their first compile and run. Both fixes were test setup, not behaviour: the test config left the engine's cap
unset (the bound read 1), and `SystemClock` needed `utc()`. The first compile also found `anyhow` missing from the
runtime's production dependencies, which is the one production change of that kind.

**Review round (ocr on 7cadfe2cf, eight findings, red first).** Each change has a test that was run before its fix.
Two were red by a real failure: the zero Retry-After (finding 5) and the authentication retry (finding 7) were reported
as waits, and the stop after a pump error did not settle the run (finding 8). The runtime feed (finding 2) was red
with only two feeds served, since the tool feed was never served. Three were red by mutation, to show each test
checks its rule: the governor adapter without delivery (finding 1), and the agents release without its refusal of a
running session (finding 4). Findings 3 (the Cargo.toml order) and 6 (one constant) are not behaviour and have no
test.

**Node divergences (68 to 75; numbered after the numbers in use on open PRs).**

68. The observer reads the runtime's model notices, not Node's network status events. Rust has no queued, admitted,
    started or completed event. So a slot-queue wait is not fed: `AskObserver::waiting_for_slot` is the hook, and the
    admission wrapper that calls it is W7-5. `model_request_completed` is fed by the caller, once per completed request.
69. The chain set is one state, not Node's per-chain aggregation. A Rust ask has one model request at a time. A completed
    request therefore ends the period with no re-report of a wait, where Node's `endChain` could re-report one.
70. `lastTool` is kept on the owner's ask, so it resets with each ask, as Node's per-ask tool activity does. Its target is
    the string the turn side passes, and Node's `AskLastTool` shape is not checked field by field.
71. The agents release removes the child's live entry. It does not close the session's table entry or its node-repl and
    browser cleanup, which Node's `closeBrowserSession` does. That path needs `table.rs`, which W7-3 does not touch, so
    the session close (9.15 item 4) is open for W7-5.
72. A stop posted to an owner that is gone is dropped, since the run it would stop no longer exists.
73. `governor_bound` floors at 1 and saturates to `u32`. The owner has already floored the cap, so the saturation is
    the only case the adapter adds.
74. `offpeak_queued` has no controller reason, so the adapter never produces it. The controller does not model an
    off-peak queue.
75. `cli` gains a dependency on `rust-cli-workflow`, and `runtime` makes `anyhow` a production dependency. Both are
    needed by the port signatures and nothing else changes in either crate's graph.

76. An authentication rejection reads `auth_refresh` in the feed. The transport retries every head-phase rejection
    (`errors/dispose.rs`, `RETRY`), renewable or not, and Node retries only a renewal. The feed reads all of them as
    Node's refresh, so none arms the stall clock. The retry of a non-renewable rejection is itself a divergence from
    Node, and it is not changed here.
77. A stop runs whatever the pump reports, and the pump's error is returned after the run has settled. Node has no
    pump, so this is the rule that keeps the residency guard from outliving a failed stop.

**Not done (left for W7-5).**

- The run service: the launch, the retune call sites, and the composition of `NodeActorSessions` over `actor_turns`.
- The subscription from an actor's child session to `AskObserver` (its model notices and tool starts).
- The admission wrapper that reports a slot wait (divergence 68).
- `QuotaAutoResume` construction, the session close path in `table.rs` (divergence 71), and shutdown (9.15 items 4 and 6).

### 9.21 W7-6: session lifecycle and residency (as built)

- `runtime/src/lib.rs`: one `Arc<SessionResidency>` built next to the session table (`OpenSessions`), held by `LocalKernel` and given to `Closer`. The process has one ledger, to be shared with the run service (W7).
- `runtime/src/table.rs`: `Closer::closing` calls `begin_close` on the ledger at once (a `CloseTicket`: retire and in-flight count in one lock), then `spawn_residency_close`, which runs the ticket on the blocking pool (`spawn_blocking` under a tokio runtime, a plain thread without one). A stuck close is logged as `session.residency_close_failed` with the anyhow chain.
- `workflow/src/residency.rs`: `begin_close` returns a `CloseTicket` (`run`, drop ends the close); `reopen` (divergence 62); `sessions_with_live_runs`; `drain` (one shared bound, and a session reached after it is spent says so); `close` is `begin_close(..).run()`. The ticket's count is what a reopen waits on.
- `runtime/src/table.rs` `start`: calls `reopen` for the session it materialises, so a resumed session accepts runs again.
- `kernel-api/src/session_api.rs`: `Kernel::live_run_sessions` and `Kernel::drain_live_runs` (both default to none). `kernel-api/src/session_deletion.rs`: `live_run_busy_ids`, the tree-order filter.
- `runtime/src/kernel.rs`: the two overrides. `drain_live_runs` drains on the blocking pool and returns each failure as text.
- `protocol-zcode/src/fork/session_tree.rs` (`running_session_ids`, so `session/treeCounts` and `session/eraseTree` both see it) and `session_delete.rs` (the single delete, refused before any side effect with `fault.command.executionFailed`, as a running turn is refused).
- `cli/src/frontends/app_server.rs`: after the protocol loop ends (reader closed or stop signal), the drain runs and each failure is logged as `app.shutdown.drain_failed`.
- Tests written first: `workflow/src/residency_tests.rs` (+4: retire, listing, drain closes, drain bound), `runtime/src/table.rs` (`residency_close_tests`, +2: the close waits off the runtime thread, a stuck close is reported), `kernel-api/src/session_deletion_tests.rs` (+2), `protocol-zcode/src/fork/session_tree_tests.rs` (+1, a live run blocks the erase), `session_delete_tests.rs` (+1, a live run refuses the delete). The drain-closes test failed on its own settler (the drain closes one session at a time), which was a test fault and is fixed. The others were red as compile errors (missing methods) before the implementation.

**Node divergences (new in W7-6, numbered from 59; fork's 9.18 ends at 58).**

59. One residency ledger per process, owned by `LocalKernel` beside the session table. Node keeps one pool per App. The same object is shared by the close path and the deletion path.
60. The session close does not wait for the residency close. Node's close awaits its guards. Rust's `Released::closing` is synchronous, and the close blocks on a condition variable, so it runs on the blocking pool and its result is only logged. The session leaves the table without waiting for its live runs to settle.
61. A stuck residency close is logged (`session.residency_close_failed`) and not returned, since its caller has returned. The shutdown drain returns its failures, and `app_server` logs them.
62. Closed sessions reopen. A session closed in this process and opened again (resume, or a reopen after `/clear`) accepts guards again: `start` calls `SessionResidency::reopen`. A reopen during an in-flight close does not block, and does not lift the mark early: it is pending and takes effect when the last close of that session ends. A close started after the reopen supersedes it. Only a reopen clears the retired mark, never a close. Tested in `workflow/src/residency_tests.rs` (`a_closed_session_accepts_guards_again_once_reopened`, `a_reopen_during_an_in_flight_close_takes_effect_when_the_close_ends`). The runtime's `start` path has no test harness, so that call is covered by review only.

**Review round (ocr on #575, eleven findings; all fixed).** Residency: a close is begun by one ledger call that retires and counts it under one lock (`begin_close`), and the job runs the ticket, so a late job never re-retires a session (`a_reopen_before_a_begun_close_runs_is_pending`, `a_delayed_close_job_does_not_retire_a_session_reopened_after_it_began`, `a_close_begun_after_a_pending_reopen_supersedes_it`). A reopen applies whatever the close's outcome, and the close's docs say so (`a_reopen_during_a_close_that_gives_up_takes_effect_when_it_ends`). A session reached after the drain's bound is spent is reported as such (`drain_is_bounded_as_a_whole_and_names_the_stuck_runs`, red first: the old message said it waited the full bound). Other: the protocol's running set takes live runs directly; the shutdown drain runs on every exit of the protocol loop, including a failed reader; the busy-id test pins tree order with two matches; the delete test pins the live-run message; the erase test pins that the agents are not told. Red first for the residency tests: the retire-then-reopen case failed against the old code (reopen returned true). The shutdown drain on the reader-error path has no test (it needs the app server harness). 63. No idle eviction exists in the Rust runtime, so `try_evict` has no caller (item 5). Node's `hasResidencyBlockingWork` deactivation is not ported. 64. The busy rule for deletion and erase is the ledger's guard count. It joins the running-turn and running-subagent facts in `running_session_ids`, so a live guard counts as `running` in `session/treeCounts`, as a running subagent does. 65. The shutdown drain is a kernel hook (`Kernel::drain_live_runs`), called from `app_server` after the protocol loop ends, rather than a hook in `protocol-zcode/src/server.rs`. The server sits inside a boxed service, and the kernel is the object the app already holds. 66. The drain's bound is the close's default (`DEFAULT_CLOSE_WAIT`, 60 seconds) for the whole drain, not per session. It is not derived from any host shutdown timeout.

### 9.22 W7-5: run service core (split into 5a and 5b; in progress)

The W7-5 brief covers more than one PR. The Node sources are about 160 KB (`dynamic-workflow-run-service.ts` 38.8 KB, `-run-launch.ts` 36.6 KB, `-run-submit.ts` 38.1 KB, `-quota-resume.ts` 13.7 KB, `-run-progress-payload.ts` 12.9 KB, `-run-lifecycle.ts` 12.6 KB), and the service test file is 410 KB. One PR is not reviewable, so it is split along the brief's own seam:

- **W7-5a** (run service core), in four PRs:
  - **5a-1** (ports): the `ChildHandler` move (step 1, done), then the `WorkflowChildRunner` port in kernel-api, its implementation in `protocol-zcode` over the compile client, the entry writer and `workflow_host::run`, a fake runner for tests, and the composition in `cli` beside the child launcher. Nothing calls the port but tests; the gate stays off.
  - **5a-2** (owner mailbox child requests): the child's asks, world reads and artifact requests reach the owner's mailbox. Merged as #578 (see 9.23).
  - **5a-3** (runtime run service): the bridge to `ActorDriverOwner`, the per-session run map, launch through the 5a-1 port (`attach_run`, AskObserver), admission through the governor, and close (`stop(Interrupted)`, the wait, `take_close_failures`, a residency timeout reported as a stuck run).
  - **5a-4** (orphan reconciliation and list): reconciliation of runs left `running` by a previous process, at construction, and the run list.
- **W7-5b** (progress and resume): the progress fan-out from `driver_owner.rs`'s publish point, `workflowRuns` served from the W7-0 projection, and `QuotaAutoResume` with its scan at session open. 5b is stacked on 5a.

**Step 1 as built (`ChildHandler` move, no behaviour change).** `ChildHandler` and the wire shapes (`CreateActor`, `ChildRequest`, `ChildEvent`, `Completion`, `WireError`, `response_line`, `RequestType`, `ChildMessage`) moved to `kernel-api/src/workflow_child.rs`. `protocol-zcode`'s `workflow_wire.rs` re-exports the shapes, and `workflow_host.rs` re-exports the trait, so the transport and its tests are unchanged. Verified by `cargo check --all-targets` and the `workflow_` lib tests of `rust-cli-protocol-zcode` (48 passed).

**5a-1 as built (ports, no behaviour change).** `kernel-api/src/workflow_child.rs` gains `WorkflowChildRunner::start(LaunchInput, Arc<dyn ChildHandler>) -> Result<RunningChild, LaunchError>` (async, `async_trait`, as `ChildLauncher`). `LaunchInput` carries what the compile, the entry file and the host read today: the script text, the run id, the frozen args, the resume origin and the cwd. Session and model bindings are not in it: nothing in the compile, the entry writer or the host reads them (bindings go only to the `display` call). `RunningChild` carries what 5a-3 needs without a second compile: the script hash, the compiled facts, the entry path and whether it fell back to temp, a cloneable `ChildStop` (`stop()` cancels the host, which drops the child's guard and ends its tree, and the outcome settles as `Stopped(Interrupted)`), and the outcome future. The host runs on its own task from `Spawner`, so the child is read while nobody awaits the outcome; dropping the outcome before it settles aborts that task and ends the tree. `LaunchError` is `Rejected { diagnostics, message }` (nothing written or started) or `Failed(text)`. `Diagnostic` moved to kernel-api with the port, and `protocol-zcode` re-exports it. `ProtocolChildRunner` in `protocol-zcode/src/fork/workflow_runner.rs` implements the port: the compile through the helper client, then `launch_compiled` (refusal, entry write, launch, host task). `write_entry`'s warning callback is `Send` now, so the runner's future is `Send`. `kernel-api`'s `testing` module gains `FakeChildRunner`, which records launches, hands the test each launch's handler, refuses on request and settles or stops the outcome. cli's `node_helper::install` builds the runner over the same helper and launcher, with `temp/workflow-runs` as the fallback, and stores it on `Context` (`set_workflow_runner`). Tests: 4 in the fake, 6 in `workflow_runner_tests.rs` (rejected compile starts nothing; entry under `.zcode/workflow-runs`; the child's create-actor reaches the handler and `complete` settles; stop ends the tree as interrupted; dropping the outcome ends the tree; a refused launch is reported). The compile helper itself is not started in those tests (the `NodeHelper` fake is private to `node_helper_tests.rs`), so the helper round trip is covered by the compile tests and by 5a-3. No divergence from Node is introduced, so no number from the 9.x list is used.

**Divergence numbering.** The highest number used anywhere in this file is 84 (section 9.15). The next free number is 85. Numbers 1 to 10 in 9.19 are local to that section.

### 9.23 W7-5a-2: owner mailbox child requests (as built)

- `workflow/src/actor_mailbox.rs`: `ActorRequest` variants and `ActorHandle` methods for the child's calls. Create-actor answers the engine's actor id. Ask, world read and publish are ticketed: each reply waits for its ticket's settlement, not for the ticket. Complete and drain answer. Log, report and phase-entered are posted without an answer, as the wire's events are. Hole and declare-artifact requests are not here.
- `workflow/src/driver_owner.rs`: `pending_tickets` (ticket to reply sender) and `unclaimed`. `route_outcomes` runs after every mailbox request and hands each settlement to its reply. `take_outcomes` routes first, then returns what no reply claimed, so the direct methods keep their behaviour. The owner's `Drop` answers every pending reply with `DriverError`.
- Stop: a live ask is settled by the engine's `abortInFlight` with `Cancelled "Run stopped."`, which the route delivers. A world read or publish is not live: its reply waits for its worker, which then settles with the run's error (`Run already settled.`), as the Node path does. A call made after settlement is refused at once with the run's error.
- Node checks (read at `origin/fork`): `engine-settlement.ts:54` (stop aborts with `Cancelled "Run stopped."`); `scheduler.ts` `abortInFlight` walks `liveNodes` only; `engine-world.ts:110-123` and `:141-171` (a world read is not a live node, and its settlement throws `state.runError()`); `engine.ts:713` (the `Run already settled.` fallback).
- Tests in `workflow/src/actor_mailbox_tests.rs` (+10): an ask is answered at its settlement and not before; a refused ask is answered at once; create-actor returns the id; a world read and a publish are answered when their worker settles; a stop answers a pending ask with `Run stopped.` and leaves a world read to its worker; the owner's shutdown answers a pending ask with an error; complete settles the run; log and phase are journaled in order. The tests were written before the implementation, but no red run was captured before it, so the red step is not evidenced.

**Node divergences (new in W7-5a-2, numbered from 90).**

90. Owner shutdown has no Node counterpart: the Node driver runs in the process and has no owner to drop. A pending reply gets `DriverError` with the text "the workflow owner shut down before this request settled".
91. An owner error from one ticketed call (a pump error after the engine admitted the ticket) is returned to that call's caller in place of the ticket's settlement. The settlement stays for `take_outcomes`. Node's promise has no such split: it settles with the ask's own outcome. Only that one call loses its reply.

### 9.24 W7-8b: SaveWorkflow and ListSavedWorkflows (as built; EvalWorkflowSnippet deferred)

**Split.** This PR ships SaveWorkflow and ListSavedWorkflows. EvalWorkflowSnippet is not in it: its run needs the sandbox child launch and the engine wiring of the run service (W7-5), which is not merged, and the helper has no `helper/workflow/evalSnippet` method (grep of origin/fork: nothing serves it). Until W7-5 lands, a snippet has no path to run, so no tool is registered for it. It stays in the W7-8b row as the follow-up.

**What is built.**

- `kernel-api/src/workflow_analysis.rs`: `WorkflowAnalyzer` port (`analyze(script) -> {ok, diagnostics}`), the typecheck of Node's `analyzeScript`. `protocol-zcode`'s `HelperWorkflowAnalyzer` implements it over `helper/workflow/format` kind `analysis` (the verdict is `ok` and `diagnostics`; the window graph is ignored).
- `fs/src/text_files.rs`: whole-file text IO for the store (read, list, write with parent directories, is-file). The tools crate has `std::fs` disallowed by clippy, so the store's IO goes through the local storage crate.
- `tools/src/saved_workflow.rs` and `saved_workflow_frontmatter.rs`: the scope, shadowing and listing types, the name rule, `Store` (list with shadowing, save with the overwrite flag, exists, shadowing facts), and the frontmatter codec. Parsing uses `yaml-rust2` (new workspace dependency; MIT or Apache-2.0). Writing is a small emitter that matches the `yaml` 2.9 output that Node produces for the shapes a definition has (goldens taken from Node: plain scalars, quoting rules, nested maps and sequences, `default` of each type).
- `tools/src/workflow_save.rs` (SaveWorkflow) and `workflow_list.rs` (ListSavedWorkflows): the tools, with the contracts from `node_workflow_tools.json` (unchanged, generated).
- `tools/src/workflow_tools.rs`: `workflow_tools(analyzer, home)` returns SaveWorkflow (only with an analyzer) then ListSavedWorkflows, in Node's registration order. `skill_loaded` is the `dynamic-workflows` probe over the session's committed history. `contract(name)` gives the generated contract.
- `protocol-zcode/src/fork/workflow_compile.rs`: `HelperWorkflowAnalyzer` and `analysis_from_value`.

**Red first.** The store and codec tests were written before their code: the first build failed on the missing types and functions (`Store`, `Meta`, `parse`, `serialize` and the others). Two expectations written by me were wrong (the body offset of a multi-line block, and the shadowing check for a global save), and each was corrected against the spec text, not the code. The tool tests were written before the tools; their first run failed on the same missing items, then on the fixture helper (a serde error for the `origin` shape of a test message), then on the `whenToUse` field name (`rename`), then on the argument key order (Node's zod output follows the shape order: type, description, required, default; checked with zod 3.25.76). The registration test replaced the W7-1 test `the_registration_returns_no_tool_before_the_engine_lands`.

**Tests.** `saved_workflow_tests.rs` (12, store), `saved_workflow_frontmatter_tests.rs` (17, codec, Node goldens), `workflow_save_tests.rs` (17), `workflow_list_tests.rs` (9), `workflow_tools_tests.rs` (2 new), `text_files_tests.rs` (2), `workflow_compile_tests.rs` (1 new). Total 60 new tests. Node cases: the store and frontmatter cases of `saved-workflows-store.test.ts` and `saved-workflow-frontmatter-offset.test.ts` that cover the save, list, shadowing and codec rules are ported; the move, resolve and argument-validation cases belong to CreateWorkflow's saved source (W7-8a) and are not ported here.

**Node divergences (new in W7-8b, numbered from 100; fork's 9.18 ends at 58, 9.21 at 66).**

100. The store runs in the agent process on the local disk, as Node does, with paths from the workspace root (a local path string). A workspace on a remote machine is not routed to that machine: the saved files are written locally. The home directory is the one passed to `workflow_tools`; Node calls `os.homedir()` per call. No entry point passes it yet.
101. No resolve-input stage. The Rust tool trait has no hook that rewrites input, so `path`, `overwrite` and `shadowing` are not added to the input the confirmation carries. They appear in the confirmation text instead (`(replaces the existing file)`, `(hides a global workflow of the same name)`, `(hidden by a project workflow of the same name)`). The input fields `path`, `overwrite` and `shadowing` are accepted and ignored. Still open: the confirmation carries no structured fields.
102. Closed in the review round. The permission decision reads the source once and keeps the approved bytes, keyed by the call's tool-use id; the call writes those bytes and never reads the draft again. A call with no approval for its id writes nothing: a script that checks clean is refused ("no confirmation"), a script that does not check gets its diagnostics. An approval is removed when its call runs, and the table is cleared past 256 entries, so a refused decision leaves at most one entry until then.
103. Closed in 9.26. Node's `alwaysAsk` (`checkAlwaysAsk` in `core/src/permission/service.ts`) asks in every mode and under a project allow rule, after the deny rules and before the yolo bypass; only session allow rules skip it. The Rust policy chain has no always-ask decision: `own()` drops the tool's `independent` flag, and `inner()` lets the bypass categories and a whole-tool allow rule through. So in those modes SaveWorkflow writes without a prompt. The no-always-allow part is kept (`independent: true`). Closing it needs a new field on `PermissionDecision::Ask` (about 25 construction sites in 21 files) and a new ask kind that `outer()` never auto-decides. This is not in this PR; the gate is off, so no session reaches the tool. It must close before the gate opens.
104. Folding and block scalars. Node's `yaml` folds a plain line longer than 80 columns and writes a multi-line string as a block scalar. This writes the long line on one line and the multi-line string as one double-quoted string with `\\n` escapes. The value read back is the same; the bytes differ. Control characters are written as `\\xHH` in double quotes, as Node does. U+0085 is double-quoted and U+2028 and U+2029 stay plain, as Node writes them (golden, `yaml` 2.9.1).
105. Metadata error texts. `invalid_yaml` details come from `yaml-rust2`, not the JS parser, except the multiple-documents text, which follows yaml 2.9's wording (line of the second `---`, the text up to it; the code frame is approximated). `invalid_metadata` lists `path: message` issues in zod's wording for the common cases, joined with `; `.
106. Skill probe. Node's absent probe passes the gate; here a session with no committed history to read (a subagent, which has no conversation output end) counts as not loaded, and the call is refused with 428. A failed Skill call (`is_error`) does not count, which matches Node's "successful call" wording.
107. Schema failures. A missing or extra field fails with the serde message, with no error code (Node's schema failure has no code either, but its text differs).
108. The checker runs twice per approved save: once for the confirmation and once in `call` only when no approval is waiting. A checker that cannot answer denies the confirmation (Node has no such path: its checker is in-process), and `call` fails with the helper's message.
109. Timeouts and cancellation. The Rust tool trait has no per-tool timeout, so Node's 15 s and 10 s limits are not declared. Both tools are not cancellable, as in Node.
110. The output display is Node's output object (`name`, `scope`, `path`, `diagnostics`, `ok`, `overwritten` when a file was written). The model text is Node's `response` text. The desktop renderer for SaveWorkflow reads the same object; it has not been checked against a running desktop.
111. `ListSavedWorkflows` lists the project root and the global root, with shadowing, like Node's undirected list. Node's `listSavedWorkflows` is called with a scope in the hub; that directed list (the global group that shows hidden copies) is not ported.
112. EvalWorkflowSnippet is not in this PR (see the split above). Its divergences are numbered when it lands.
113. A `script_path` must resolve inside the workspace (lexical normalization; symlinks are not resolved). Node accepts any path, absolute or escaping. A path outside is refused at the permission decision with "is outside the workspace".
114. The `script_path` advice names `script_path` (Node's text names `path`, which is the output field of this tool).
115. The `script_path` read moved from input validation to the permission decision, so a refused draft is a permission refusal, not a 400 input refusal. Validation reads nothing from the disk.
116. The store's IO runs on a blocking thread (`spawn_blocking`); Node's store is synchronous on the event loop.
117. The fs store helpers are not atomic (as Node's `writeFileSync`). A non-UTF-8 file name is converted lossily and so lists as an unusable file.

**Not done here.** The gate source is still set by no entry point (divergences 55 and 56 of 9.18), and nothing calls `workflow_tools`, so SaveWorkflow and ListSavedWorkflows reach no session. The skill-gate probe is unit-tested on a fixture history only. Divergence 103 must be closed before the gate opens. The move, resolve and argument validation of the saved store belong to W7-8a (CreateWorkflow's saved source).

### 9.25 W7-5a-3: runtime workflow run service (as built, part)

**Scope built.** `runtime/src/workflow_run.rs` (service, bridge, owner host) and `workflow_run_tests.rs` (13 tests). Launch, the child bridge, the run map and close are in. Not built: the production owner assembly, the cli composition (the gate stays off), admission beyond the governor bound, and orphan reconciliation (5a-4). See "Not done" below.

**Where it lives.**

- `WorkflowRunService` holds one run map and a `SessionResidency`, a `RunConcurrency` and a `WorkflowChildRunner` (all ports). `OwnerFactory` builds a run's owner over its mailbox on the launching thread. `HostedOwner` (`Hosted<J, S>` in production shape) attaches the run (`attach_run`, 9.12 and 9.15) and serves the owner's mailbox on a thread.
- `WireBridge` implements `ChildHandler`. Create-actor and events are direct mailbox calls. Ask, world read and publish are sent with `ActorHandle::send_ticketed`, drained, and awaited (`ticketed`). Errors map to the wire as Node's `toWireError` does (`name` and `code` are the error code; `violations` and `finalText` are kept).
- `workflow/src/actor_mailbox.rs` and `driver_owner.rs` gain two small pieces the bridge needs: `ActorRequest::Fail` (`ActorHandle::fail`, `ActorDriverOwner::fail`, the engine's `fail`) for a child's failed `complete`, and `send_ticketed` / `await_ticketed` (a ticketed call sent without waiting).

**Launch (one synchronous step after the compile).** Order: a closed service and a run without a parent are refused first; then the child is started (compile, entry write, spawn), which creates no engine and no run row for a rejected script; then, under the run map's lock with no await, the owner is built, attached (residency guard, governor bound, redrive and stall clocks), its thread is started, and the entry is inserted. A failed attach or thread start stops the child and keeps no entry. A close that ran during the compile refuses the launch and stops the child.

**Close.** `close` marks the service closed (later launches are refused), takes the run map, stops each child and posts `stop_interrupted`, then calls `SessionResidency::close` once per parent session on the blocking pool. A session that does not close in time marks its runs stuck. The other owner threads are joined, and their `take_close_failures` are returned in `CloseReport`.

**Settlement.** The child's outcome drives the owner: `complete` (ok), `fail` (a script error), or `stop_interrupted` (the stream stopped). The owner thread ends once its run settles, whatever settled it (the child's outcome, a residency stop, or close). Then, on that thread, the child is stopped and the run's entry is removed, unless close took it; close joins the threads it took.

**Tests (red first).** The module was written with `todo!` bodies, and the 13 tests were run first: 12 failed on the stubs (the thirteenth is an existing test). Then the bodies were implemented. Two of the first green-run failures were test faults, fixed in the test: the wait helper blocked the single-threaded test runtime (it now yields), and a ticket reply was dropped when the owner settled on the same call (the bridge now keeps the reply). Test names: a launched run holds its guard and bound until its child completes; a rejected script starts no child; a run without a parent is refused before anything starts; a residency refusal stops the child and keeps no entry; a closed service refuses a launch; a duplicate live id is refused; close stops a live run as interrupted and waits for its guard; close reports a non-closing residency as stuck; a child's log and phase do not wedge the owner; a child's error fails the run and releases it; an ask for an unknown actor is answered with the engine's error; create-actor on a dead owner is refused.

**Admission (finding, not built).** Node's launch has no run-level slot wait: the run's cap is a governor bound (`setRunBound`), and slot waits happen per model request in the driver's admission port (`workflow-concurrency-governor.ts`). The Rust equivalent is already in place (9.10, 9.20: the bound through `attach_run`, the wait through `AskObserver::waiting_for_slot`). So the run service adds only the bound, which it does.

**Not done (for the follow-ups).**

- The production owner assembly: `NodeActorSessions<'a, T>` borrows a `rusqlite::Connection`, so an owner moved to a thread needs an owned journal and session set. The `OwnerFactory` seam is where that goes. No production `TurnRunner` is passed in yet.
- The cli composition (`node_helper::install`) does not install the service yet; the gate stays off, and nothing user-visible changes.
- Orphan reconciliation and the run list (5a-4); progress fan-out, `workflowRuns`, quota auto-resume (5b).
- The mailbox has no `declare-artifact` or hole request (9.23 defers them); see divergences 123 and 124.

**Node divergences (new in W7-5a-3, numbered from 120).**

120. The drain follows each ticketed call, not each slice of calls. The handler trait has no slice boundary, so each ask, world read or publish is sent, drained, and awaited. A drain with nothing queued is a no-op, so only the timing of starts within one slice can differ.
121. Close is bounded. The residency close waits the default 60 seconds, and a run whose guard is not released in time is reported as stuck. Node's close awaits settlement with no timeout (`dynamic-workflow-run-service.ts` invariant 7; `dynamic-workflow-run-lifecycle.ts`, the close's doc comment).
122. A stuck run's owner thread is not joined and is left to end on its own, and its entry is dropped. Node's close never returns in that case.
123. A child's `declare-artifact` fails the run with `DriverError`, "declare-artifact is not wired yet". Node records the artifact. The mailbox has no such request yet (9.23 defers it to W7-5b), so the declaration is refused rather than dropped.
124. A hole request is refused with a `DriverError` wire error until W7-8. Node fills the hole.
125. A script's error keeps its message as the run's error. Node also records the sandbox's stack as the run error's cause (`dynamic-workflow-runtime` `harness.ts`, the `complete` case). The stack is not kept.
126. A host-side stop (the child's stream ended before `complete`) settles as `stop_interrupted`, which carries no error text. Node passes an `Interrupted` error with the cause (`harness.ts`, the sandbox-crash case), and journals it. Here the reason and cause are logged (`workflow.run.host_stopped`) and not journaled; the mailbox's stop takes no error. A stop the service asked for (close, or the run settling) is logged at debug only.
127. A call after the run settled is refused by the owner's closed mailbox, with the mailbox's "owner is gone" text. Node answers with the run's own error (`Run already settled.`).
128. A settled run's entry is removed when its child completes. Node keeps up to 32 terminal entries for observation (`TERMINAL_REGISTRY_LIMIT`, `dynamic-workflow-run-lifecycle.ts`). Retention belongs with the run list (5a-4 and 5b).
129. An attach refused by the residency after the child started stops that child, and its outcome is dropped. Node's residency refusal throws before the engine starts (the close gate). The child was briefly started here.
130. Each live run has one owner thread. Node's owner runs on the process event loop. The owner must stay single-threaded, so the thread is per run, and the closes wait on it.
131. The host awaits a child's `create-actor` before it reads the next line, since later requests name the engine id it returns. The wait is a future on the blocking pool (`ChildHandler::create_actor` now returns a `BoxFuture`), so a busy owner does not hold a runtime thread. Node's `createActor` is synchronous. Ordering is kept; only the thread is freed.
132. Close failures of runs that settled on their own are kept for the next close up to 64 (`FAILURE_BUFFER_LIMIT`); each is logged when collected (`workflow.run.close_failed`), and later ones are logged and dropped. Node has no such buffer: its failures are returned to the caller that closes the App.

**Review round 2 (ocr delta on #581, five findings).** A panic in the owner's `serve` is caught on the owner thread, so settlement runs however serve ends: the child stops, the id is freed, and the panic is a close failure (a test shows a panicking owner, then a relaunch, then the report). A declare-artifact failure is posted inline (`ActorHandle::fail_posted`, no reply) so it keeps its queue position before a later `complete`; the ordering test runs 200 rounds and passed on the pre-fix code too, so it pins the contract rather than showing a red. Duplicate's text covers a launch still starting. A service-requested stop logs at debug. The `ChildHandler` summary names both futures: `request` concurrent, `create_actor` awaited inline.

**Review round (ocr on #581, eleven findings).** Fixed: a run that settles engine-side (a residency stop, a failed declare-artifact, any settlement) now stops its child and frees its entry and id, on the owner's thread (H1); the owner is built outside the service lock, and the lock covers only the re-check, the registrations, the thread and the entry (M1); a `declare-artifact` event and a `create-actor` no longer block the host reader (M2, M3); two concurrent launches of one id start one child, since the id is reserved before the compile (L3); a create-actor success path is tested (L4); a drain refusal is logged (L5); a host stop logs its cause (L6, divergence 126); `LaunchFailure` is a `std::error::Error` (L7). Red first: stage A ran the behavioural tests against the old code (six failed: the settlement test, the factory deadlock watchdog, the two blocked-caller watchdogs, the concurrent launches, and the buffer stub); stage B recorded the signature reds (the create-actor future, the error impl). Rejected: none.

### 9.26 Policy: always-ask through the permission chain (divergence 103 closed)

Divergence 103 (recorded in 9.24, from PR #580) is closed here. Its numbering stays local to this section: the items below are lettered (a to e), so they take no divergence numbers. PR #581 uses 9.25 with divergences 120 to 130; this section is 9.26 to keep clear of it.

- `PermissionDecision::Ask` gains `always_ask` (kernel-api), set by `PermissionDecision::always_ask(message, suggestions, independent)`. `independent` keeps its meaning (no always-allow offered). An ordinary ask has `always_ask: false`, so no existing tool changes.
- `policy/src/chain.rs`: `own()` turns an always-ask into `AskKind::Always` (a unit kind) with `Check::Ask.independent` set from the tool's decision, after the built-in check. Ordinary asks have `independent: false`. Only that check's deny stands (a content deny rule). `inner()` returns it before every allow branch (the tool-wide allow rules, `full_access` (bypass and yolo), guarded, and the plan gate). `plan_mcp` passes it through. `outer()` never auto-decides it: no classifier, and Node's plan mode asks it instead of denying.
- Node rules matched (`apps/zcode-cli/packages/core/src/permission/service.ts`, `checkAlwaysAsk`, read at `origin/fork`, and called from `checkPermission` after `requiresUserInteraction` and the guarded user-approval rule, before yolo and the plan gate):
  1. `mode === "auto"` (the base is auto too, with plan on): deny `mode.auto.unimplemented`. Rust: `always()` (auto) and the base-auto deny in `lib.rs`.
  2. `disallowedTools` and project deny rules (whole tool and content): deny. Rust: the tool-wide deny rules in `inner()`, and the built-in check's deny in `own()`.
  3. Session allow rules (`sessionRules`, "always allow in this session"): allow, no event, no dialog, in every mode (yolo, plan, build). Rust: `Rules::session_whole_tool_allow` (RuleSource::Session, whole tool).
  4. Otherwise ask, with `alwaysAsk: true` on the decision. No mode, bypass, yolo, guarded, plan or project allow rule passes it.
  5. A PreToolUse hook's allow does not remove it (`hook-flow.ts` `applyPreToolPermissionDecision`). Rust: `check_rules` returns the always-ask ask, and the pipeline asks again.
  6. PermissionRequest hooks still run for it (it is not `once`), as for other asks.
- Remaining differences from Node (narrowing, not closed):
  - a. Session allow rules skip the always-ask only as whole-tool rules. Node's session rules also match `Tool(content)`. A content session rule does not skip an always-ask here. The gate is off and no always-ask tool that takes a content grant exists yet.
  - b. The per-call `allowed` rules (skill `allowed-tools`) do not skip an always-ask. Node's equivalent for skills was not traced.
  - c. Node's owner exemption (`isOwnedWorkflowAmend`, for AmendWorkflow and FillWorkflowHole) is not built. It arrives with those tools.
  - d. Rust has a `dontAsk` mode (Node has none): an always-ask there is denied, as every ask is. `avoid_prompts` (no one to answer) denies it, as every ask.
  - e. `Check::Ask.independent` is true only for an always-ask. An ordinary ask from a tool's own check stays `independent: false`, as before (plan MCP sets its independent ask in the chain). Carrying it for ordinary asks would change no existing tool, and none asks that way today.
- Tests: `policy/src/lib_tests_always_ask.rs`, through `PolicyGate::decide` and `check_rules`. Red before the chain change: an always-ask tool was an ordinary ask (Default) and an Allow under guarded, bypass, and a user, project, local or CLI allow rule. Green after.
- SaveWorkflow (#580, merged as 49687cfd8) is the first user: its `check_permissions` returns `PermissionDecision::always_ask(…, independent: true)` (`tools/src/workflow_save.rs`, the `always_ask(..., true)` call). This is the Node check: `apps/zcode-cli/packages/core/src/tool/handlers/save-workflow.ts:289,292` sets `alwaysAsk` true and `allowAlways` false, so the prompt is asked in every mode with no always-allow offered. Its test `save_workflow_asks_through_the_policy_chain_and_only_a_session_rule_skips_it` (`tools/src/workflow_save_tests.rs`) runs through `PolicyGate::decide`. A PreToolUse allow is covered by `a_hook_allow_does_not_skip_an_always_ask_in_the_pipeline` (`tools/src/pipeline_hook_tests.rs`), which runs the real policy gate and asks again.

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
