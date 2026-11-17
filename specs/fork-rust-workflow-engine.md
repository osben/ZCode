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

Not in the W5a row, and needing an owner: `engine-holes.ts` (226), `engine-artifacts.ts` and `-primary.ts` (527 and 45), `engine-report.ts` (206). `engine-world.ts` (233) and `imported-cache*` belong to W5b. `concurrency.ts` (345, the governor) belongs to W6b.

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
