# MR !1466 Off-Peak Task: Change Walkthrough

> Audit of the MR's real Git boundary, final code behavior, test coverage and known gaps. It does
> not present early plans, intermediate commit states or document aspirations as shipped.
>
> Audit date: 2026-07-21; MR `!1466`; target branch `main`; source branch `feat/off-peak-task`.
>
> **2026-07-23 follow-up:** D44 removed the Off-Peak specific `awaiting_approval` type/Repo/UI/
> notification shell. Where this file mentions them it reviews the historical MR Head boundary;
> current behavior is in `spec.md` and the code: permission/elicitation goes only through the ordinary
> session, the Off-Peak aggregate stays `running`, and the current turn does not switch provider.

The per-commit evolution table (60 commits), the per-file inventory (115 changed paths) and the
mechanical check results of the original are dropped.
Full history: `git show b8876e8b:docs/off-peak-task/mr-1466-complete-change-walkthrough.md`

## 1. Audit scope and conclusion

### 1.1 Git boundary

| Item        | Value                                                     |
| ----------- | --------------------------------------------------------- |
| MR          | `!1466` - `Draft: feat(off-peak): 闲时任务 Off-Peak Task` |
| Base SHA    | `14a62011d582ccbd20ef4c274892ae0dea076bd9`                |
| MR Head SHA | `cc3980d2a1f1523f362cb1a6e80d5ba2482cc5b7`                |
| Commits     | 60 (55 non-merge + 5 branch-sync merges)                  |
| Files       | 115, `+14,429 / -1,707`                                   |
| MR state    | Draft, Open, no conflicts; latest pipeline manual/blocked |

The local branch additionally contained `5c6d0e9d7f chore: release v3.5.3-alpha.0`, which is not in
the MR Head and not counted here.

### 1.2 Result in one sentence

The MR adds a desktop-local one-shot idle-time task product: the user first takes a number from the
server; the client persists the task and polls tickets; once the server admits, an independent
scheduler dispatches to the window Local Host that owns the target workspaceKey; the Host creates or
reuses an ordinary ZCode session and injects the built-in `builtin:offpeak-idle-plan` provider only
for the automatic turn; on a capacity `429/3105` it obeys `Retry-After` with unlimited waiting and
without consuming the ordinary retry budget; on ticket `3102` it re-takes and continues in the same
session; after the task ends it settles the ticket asynchronously.

### 1.3 Actual scope

- Off-Peak domain types, SQLite table, Repo state machine, server ticket client, sync and settle
  service.
- The desktop scheduler -> main -> window Local Host -> workspaceKey Agent dispatch loop.
- Agent/CLI single-turn provider overlay, model restoration, `429/3105` wait and `3102` continuation
  marker.
- Automations create, edit, list, History, sidebar group, notifications, gray release and quota gate.
- The global "keep awake while running" setting.
- Mock gateway, unit tests, service integration tests and two WDIO E2E specs.
- Docs, decision records, conversation case catalog, coverage matrix.

Two non-core changes also ride in the MR: GitLab CI allows API-source triggering of some manual
test/build chains, and `mise run dev` uses a separate `~/.zcode-dev-home` to isolate the production
data directory.

## 2. Final product semantics

### 2.1 What the user sees

- An idle-time task is a one-shot task, neither cron nor a repeatable automation.
- Creation takes title, Instructions, project, permission mode, idle model and reasoning level.
- Successful creation means the server number is taken; no conversation is created yet.
- A server ticket must reach `ready` before dispatch; the first dispatch creates an ordinary session.
- When a 3-hour execution segment expires, a new ticket can be taken and the original session reused.
- Locally there is always one logical task record; a new ticket overwrites the current
  `server_ticket_id` and adds no task.
- History shows at most 1 row per task, not expanded per 3-hour segment or ticket.

### 2.2 User-visible provider vs the provider actually used

| Scenario                                                | Model bar / resident session model                                 | Provider the current request really uses                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| First idle dispatch creates the session                 | the user's workspace default model, full `providerId/modelId` kept | the automatic turn temporarily uses built-in `builtin:offpeak-idle-plan`                                                          |
| Later ticket-segment continuation                       | still the same session's resident user model                       | the continuation turn again temporarily uses `builtin:offpeak-idle-plan`                                                          |
| After the automatic turn ends                           | the resident user model is restored                                | later ordinary messages use the user provider                                                                                     |
| Permission approval during an unfinished automatic turn | model bar still shows the resident user model                      | still inside the same idle-plan turn; **approval does not switch provider**                                                       |
| User sends a prompt while the automatic turn is busy    | model bar still shows the resident user model                      | the message is queued; after the automatic turn clears the overlay and restores the model it drains, so it uses the user provider |

The resident session model of a multi-provider user is not "the first provider". Before the first
dispatch the host calls `workspace/readState(preferWorkspaceDefaults=true)` and picks a full model
reference still in the available set, in order: `modelCatalog.defaultModel`,
`modelCatalog.lastUsed`, `settings.model.current`. A candidate equal to `builtin:offpeak-idle-plan`
is skipped; with no candidate the dispatch fails with a permanent error. The model in the create form
decides only the model of the idle-plan automatic turn and does not override the resident session
model.

### 2.3 Ask approval: actual landing state at MR Head

The plan text said sensitive operations enter `awaiting_approval`, approval shows "continuing will
use your own plan quota", then switches to the user provider. **The production code at MR Head did
not complete this chain:** the Repo had `setAwaitingApproval()` and the shared state, UI badge, card
actions and system notification reserved `awaiting_approval`, but the production run chain never
called `setAwaitingApproval()`; there was no Off-Peak approval handler, no provider switch after
approval and no runtime hint. The permission request belongs to the current automatic turn whose
`turnRuntimeModel` is cleared only at the turn-complete boundary, so execution after approval stayed
on the idle-plan provider. `awaiting_approval` was therefore a modeled, rendered but unwired reserved
state (later removed by D44).

### 2.4 What "queue" means

Three different queues must not be mixed into one global FIFO:

| Layer                        | Stored in                             | What is queued                                                        | Authority                              |
| ---------------------------- | ------------------------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| Server ticket queue          | Off-Peak server                       | tickets taken by users; returns `position` and turns `ready` off-peak | authority for idle admission order     |
| Scheduler dispatchable queue | local `off_peak_tasks` + claim fields | local tasks synced to `schedulable=true`, claimed by `queued_at`      | dispatch order of this local host      |
| Conversation message queue   | existing session/agent runtime        | ordinary prompts the user sends while the agent is busy               | message order inside that session only |

`next_poll_at` is written into the task table, but the service uses one shared timer for polling the
whole batch of non-terminal tickets, not an independent timer per task.

## 3. Full-chain architecture

```text
Renderer / packages/ui
  │
  │ IOffPeakTaskService RPC
  ▼
Window Local Host Process
  ├─ OffPeakTaskService ──────► OffPeak Server
  │    ├─ availability             GET  /ticket/availability
  │    ├─ take number              POST /ticket
  │    ├─ batch sync               POST /ticket/status
  │    └─ settle outbox            POST /ticket/:id/settle
  │
  ├─ OffPeakTaskRepo ─────────► tasks-index.sqlite / off_peak_tasks
  │
  └─ ZCodeTaskService / Agent session
         ▲
         │ OffPeakRun routed to the window Local Host owning the workspaceKey scope
         │
Desktop Main Process ◄──────── Scheduler Utility Process
  │                              ├─ 20s tick
  │                              ├─ recover interrupted claims
  │                              ├─ claim schedulable queued rows
  │                              └─ transient dispatch backoff
  │
  └─ powerSaveBlocker (global setting)

Agent / zcode-cli
  ├─ persistent session model = user's workspace model
  ├─ per-turn catalog/model overlay = builtin:offpeak-idle-plan
  ├─ POST /api/v1/off-peak/anthropic/v1/messages
  ├─ 429/3105 + Retry-After => wait and retry without budget consumption
  └─ 400/3102 => stable expired marker => host requeues same task/session
```

- The scheduler and host both open the same tasks-index SQLite and cooperate through transactional
  claim and state guards.
- Main only forwards scheduling messages and manages system capabilities; it holds no ticket/session
  business state.
- Relay, mobile remote and desktop main gained no replayable task state source. Desktop stays on
  `desktop-continuous`; the mobile replayable recovery semantics were not spread into the desktop
  chain.

## 4. Two-axis state machine

### 4.1 Client task state

```text
                         ┌──────────── Pause ────────────┐
                         │                               ▼
create + take ticket ─► queued ── server ready ──► claimed ── dispatch ─► running
                         ▲             │                │                  │
                         │             └─ claim fail ───┘                  ├─ success ─► completed
                         │                                                ├─ failure ─► failed
                         │                                                ├─ cancel ──► cancelled
                         │                                                └─ 3102 ────► queued
                         │
                         └──────── Continue / retake ◄──── paused

Reserved but not wired: running ── permission request ──► awaiting_approval
Terminal: completed / failed / cancelled, none can exit.
```

- `queued`: number taken, waiting for server ready, or re-queued after restart/continuation.
- `paused`: the user stopped local dispatch; the server ticket itself keeps aging.
- `running`: the host accepted the `sendPrompt` dispatch and replied ACK.
- `awaiting_approval`: reserved in domain and UI, unreachable in the production run chain.
- `completed`, `failed`, `cancelled`: terminal.

### 4.2 Server ticket state

```text
POST /ticket
    │
    ▼
  queued ──off-peak and its turn──► ready ──first messages admission──► active
                           │                              │
                           ├─ ready TTL expires ────────► expired
                           └─────────────────────────────► settled ◄── client settle
                                                          ▲
                       active 3h expiry ─► expired ───────┘ (re-take and continue)

A query can also return not_found.
```

### 4.3 Axis mapping and deviations

| Server state | Local sync action                                                     | Typical client state                                      |
| ------------ | --------------------------------------------------------------------- | --------------------------------------------------------- |
| `queued`     | `schedulable=false`, write position                                   | `queued` or `paused`                                      |
| `ready`      | `schedulable=true`, wake the scheduler                                | `queued`, dispatchable next                               |
| `active`     | keep the activated snapshot                                           | usually `running`                                         |
| `expired`    | queued task auto-retakes; running closes the loop via messages `3102` | back to `queued`                                          |
| `settled`    | clear the schedulable snapshot                                        | normally terminal; an unexpected initial state may linger |
| `not_found`  | ignored by the current sync, no auto retake                           | may linger; the user's Continue can re-take               |

Important deviation: local `running` is written after the `sendPrompt` ACK, while whether the gateway
passes the messages fine valve happens later. During a `429/3105` wait the UI therefore shows
running, not a separate "server capacity queuing".

## 5. Data model and persistence

### 5.1 Identity

- `offPeakTaskId`: local primary key and stable server `task_id`; unchanged across tickets.
- `serverTicketId`: current server ticket; overwritten on each re-take.
- `conversationId`: host ZCode task id; backfilled after first dispatch.
- `sessionId`: Agent session id; backfilled after first execution, reused on continuation.
- `workspaceKey = workspaceIdentity?.trim() || workspacePath`: identity isolation key.
- `workspacePath`: real path semantics for files, cwd, display.
- `workspaceIdentity`: the remote identity field is kept by type and protocol, but the product UI
  forbids creating idle-time tasks in a remote workspace.

### 5.2 Table `off_peak_tasks`

Stored in the existing tasks-index SQLite with WAL, `synchronous=NORMAL`, `busy_timeout=5000`.

| Column                                                  | Meaning                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `off_peak_task_id`                                      | stable task primary key / server task_id                                         |
| `server_ticket_id`                                      | current ticket id                                                                |
| `title`, `prompt`                                       | user title, Instructions                                                         |
| `conversation_id`, `session_id`                         | ZCode task id, reusable Agent session id                                         |
| `permission_mode`                                       | existing task mode build/edit/plan/yolo                                          |
| `model`, `thought_level`                                | idle plan automatic-turn model; reasoning level (added by incremental migration) |
| `workspace_key`, `workspace_path`, `workspace_identity` | identity isolation key, real path, optional remote identity                      |
| `status`                                                | client seven-state                                                               |
| `queued_at`                                             | local FIFO order time                                                            |
| `started_at` / `ended_at`                               | lifecycle times                                                                  |
| `failure_reason`, `files_changed`                       | failure reason, best-effort changed-file count                                   |
| `settled_at`                                            | server settle ACK time                                                           |
| `history_deleted_at`                                    | logical History deletion time (incremental migration)                            |
| `registered_at`                                         | take-number success time                                                         |
| `schedulable`, `queue_position`, `next_poll_at`         | local snapshot of server ready / position / suggested next poll                  |
| `claim_running` / `claimed_at`                          | scheduler claim lock and time                                                    |
| `attempt_count` / `last_error`                          | dispatch record / diagnostics                                                    |
| `created_at` / `updated_at`                             | local audit times                                                                |

Indexes: `(status, queued_at)` for status filtering and FIFO claim; `(workspace_key, status)` for
workspace-isolated queries.

### 5.3 Mechanical guards in the Repo

`OffPeakTaskRepo` implements: table creation, incremental `ensureColumn`, row -> domain mapping;
create/list/get/physical delete/History tombstone; counts of non-terminal and active tasks; editing
only for `queued/paused`; updating the server scheduling snapshot; FIFO claim inside a
`BEGIN IMMEDIATE` transaction (a claim older than 10 minutes is stale and re-claimable);
`markRunning` accepting only queued with first time/session fields preserved by `COALESCE`;
`markTerminal` forbidding a late result from overwriting a terminal state; conditional transitions
for awaiting, pause and release-claim; startup recovery putting interrupted claimed/running tasks
back to queued while keeping the session; `requeueForContinuation` keeping task/session on
re-ticketing; unsettled-terminal outbox query and `markSettled`.

## 6. Key sequences

### 6.1 Create and take number

```text
UI                    Host Service             Off-Peak Server          SQLite
│ createTask(params)       │                          │                    │
├─────────────────────────►│                          │                    │
│                          │ generate stable task_id  │                    │
│                          ├─ POST /ticket ──────────►│                    │
│                          │◄─ ticket/state/position ─┤                    │
│                          │                          │                    │
│                          ├─ INSERT task ────────────────────────────────►│
│                          ├─ start sync / wake if ready                  │
│◄─────────────────────────┤                          │                    │
```

- The order is "take the server number first, then persist locally": a failed take leaves no fake
  task. Risk: a successful take followed by a failed SQLite insert leaves an orphan server ticket;
  there is no active settle compensation.
- A server `ready` wakes the scheduler immediately, without waiting for the next 20s tick.

### 6.2 First dispatch and session creation

```text
Sync Service       SQLite/Scheduler       Main       Window Local Host       workspaceKey Agent
│ ticket=ready          │                  │              │                    │
├─ schedulable=true ───►│                  │              │                    │
├─ wake scheduler ─────►│                  │              │                    │
│                       ├─ transactional claim             │                    │
│                       ├─ OffPeakRun ─────►│─────────────►│                    │
│                       │                  │              ├─ read workspace model
│                       │                  │              ├─ createTask(model=user default)
│                       │                  │              ├─ build idle-plan turnRuntimeModel
│                       │                  │              ├─ sendPrompt ───────►│
│                       │                  │              │◄─ dispatch ACK ─────┤
│                       │◄─ success ───────│◄─────────────┤                    │
│                       ├─ markRunning(session/task ids)                        │
│                       │                                  Agent turn continues │
```

`running` means the dispatch ACK, not that the model has produced tokens or that the server messages
capacity valve was passed.

### 6.3 Single-turn model overlay and restoration

```text
workspace catalog/model                  turn overlay
        │                                      │
        ├─ snapshot previous selected model    │
        ├─ setTurnOverlay(offpeak provider) ──►│
        ├─ setModel(offpeak model, transient)  │
        ├─ run automatic prompt                │
        │                                      │
        ├─ turn terminal boundary              │
        ├─ restore previous model              │
        ├─ clearTurnOverlay / clear secrets    │
        ├─ emit ready                          │
        └─ drain queued user messages using restored user provider
```

- The workspace overlay and turn overlay are stored in layers; a workspace hot refresh does not
  overwrite a still-running turn overlay.
- The provider config is injected in memory only and never written to the workspace catalog, session
  persistence or disk.
- Injection and restoration emit no ordinary model-change UI event, so the model bar does not flash
  to Idle plan.
- If the original model is removed during the automatic turn, the secret-bearing temporary overlay is
  cleared first and the fallback comes from the latest catalog.
- When the agent is busy, a sendText carrying another `turnRuntimeModel` is rejected and the
  scheduler treats it as a transient dispatch failure.

### 6.4 How `429/3105 + Retry-After` works

```text
Agent adapter              Off-Peak messages endpoint
     │ request attempt                  │
     ├─────────────────────────────────►│
     │◄─ HTTP 429, code=3105,           │
     │   Retry-After: N seconds         │
     │                                 │
     ├─ classify only when providerId == builtin:offpeak-idle-plan
     ├─ delay = min(parsed Retry-After or 60s, 5min)
     ├─ abort-aware wait
     ├─ do not consume ordinary retry budget
     └─ retry same provider request ───►│
```

- `offpeak-retry.ts` applies only to `providerId=builtin:offpeak-idle-plan`; ordinary providers are
  unaffected.
- A bare HTTP 429 and business code 3105 are both classified as `queued`.
- Without a parsable `Retry-After` the default is 60s; a single wait is at most 5 minutes.
- The generate runner rolls back the attempt / keeps the queue decision so the capacity wait does not
  consume the ordinary retry budget and can probe indefinitely.
- The stream runner retries safely only before a visible output boundary, so already output content
  is not repeated to the user.
- The wait uses an abort signal and can be canceled; it is not an uninterruptible sleep.
- Projection maps it to a recoverable rate-limit fault with the reason enum
  `ModelRetryReason.OffpeakQueued`.

### 6.5 `3102` ticket expiry continuation

```text
messages 400/code=3102
      │
      ▼
adapter: non-retry + append stable marker "off-peak-ticket-expired"
      │
      ▼
host terminal observer detects marker
      │
      ├─ requeue same offPeakTaskId, preserve conversationId/sessionId
      ├─ POST /ticket for a new ticket
      ├─ overwrite serverTicketId/scheduling snapshot
      └─ scheduler later resumes same session with continuation prompt
```

- The new contract code is 3102; the adapter still accepts the old gateway's 3001 for rolling
  releases.
- Continuation uses a fixed English continuation prompt and re-applies the original permission
  mode/thought level.
- The task and session are the same ones; no ticket history is stored locally.

### 6.6 Pause, Continue, Cancel, Delete

```text
Pause:
  queued ─► paused, blocks local scheduler dispatch; the server ticket does not pause and may still become ready/expired.

Continue:
  paused ─► query the current ticket
             ├─ queued/ready/active or query failure: reuse the current ticket
             └─ expired/not_found/missing: POST /ticket again
           ─► queued

Cancel:
  local terminal cancelled first
  ├─ best-effort stop active agent task
  └─ best-effort settle; failure is left to outbox retry

Delete:
  cancel + best-effort settle
  └─ physical DELETE local row

Delete history:
  only writes history_deleted_at; task, session and execution fields are kept.
```

Known risk of Delete: if settle fails on a network error/5xx and the row is then physically deleted,
the local outbox basis is deleted too and the settle can never be re-reported automatically.

### 6.7 Restart recovery

```text
desktop/scheduler restart
  └─ recoverInterrupted(now)
       ├─ stale claim/running → queued
       ├─ release claim fields
       ├─ preserve session/task identity
       └─ wait for valid/retaken ticket and resume
```

## 7. Server interfaces, auth and error semantics

### 7.1 Five conceptual endpoints

| Purpose                     | Method and path                               | Caller                          |
| --------------------------- | --------------------------------------------- | ------------------------------- |
| Create-eligibility snapshot | `GET /api/v1/off-peak/ticket/availability`    | host service                    |
| Take number                 | `POST /api/v1/off-peak/ticket`                | host service                    |
| Batch ticket status         | `POST /api/v1/off-peak/ticket/status`         | host service                    |
| Settle                      | `POST /api/v1/off-peak/ticket/:id/settle`     | host service                    |
| Model messages              | `POST /api/v1/off-peak/anthropic/v1/messages` | temporary provider inside agent |

Early docs' "four endpoints" counted only ticket-management endpoints; with availability it is four
ticket JSON endpoints plus one model endpoint.

### 7.2 Auth

- Ticket JSON endpoints carry `Authorization: Bearer <ZCode JWT>` and `x-coding-plan-api-key`; the
  messages endpoint also carries `X-Off-Peak-Ticket-ID`.
- The JWT is read from the credential key `zcodejwttoken`.
- The Coding Plan key is resolved by the current provider family and selected connection: ZAI/BigModel
  personal plans read the raw `apiKey` of the selected provider; BigModel Team reuses the existing
  runtime-key helper to produce `${apiKey}.${secretKey}`.
- Start Plan, API Key mode, unselected, active OAuth provider differing from the selected family, and
  disabled/stale connections are rejected; the UI, ticket client and per-turn runtime share one host
  credential snapshot and must not scan or fall back to any cached provider.
- Missing JWT, Coding Plan key, idle model or user workspace model produce a typed permanent dispatch
  error, avoiding pointless repeated claims.

### 7.3 Parsing and timeouts

- 10s timeout per request; Zod loose/passthrough allows added server fields; `position: null`
  normalizes to field absent; `next_poll_after` is read in seconds and converted to ms; both bare
  JSON and the `{ code: 0, data }` envelope are accepted.
- Batch status sends at most 100 tickets; the rest is truncated with a warn, not split.
- Availability returning `can_take_number=false` without `next_take_at` is a dirty response and
  throws; the UI is fail-closed per D43 and waits for the next successful refresh.

### 7.4 Business codes

| HTTP/business code | Handling                                                                            |
| ------------------ | ----------------------------------------------------------------------------------- |
| `3101`             | not eligible, creation fails, UI shows the matching error                           |
| `3103`             | cannot take number now / quota limit; refresh availability; no permanent local bool |
| `429` / `3105`     | messages capacity queue; wait per Retry-After, no ordinary retry budget consumed    |
| `400` / `3102`     | ticket unavailable; produces the stable marker; re-take and continue                |
| legacy `3001`      | old-gateway compatibility only, same as 3102                                        |

## 8. OffPeakTaskService: take number, sync and settle

### 8.1 Service surface

`IOffPeakTaskService` exposes `getTakeNumberAvailability`, `createTask`, `cancelTask`, `pauseTask`,
`continueTask`, `deleteTask`, `deleteHistory`, `updateTask`, `list`, `get`. The renderer never
operates server tickets; take-number, polling, re-ticketing and settle stay in the service layer.

### 8.2 Sync loop

- The timer is kept only while relevant non-terminal tasks or unsettled terminals exist.
- Normal polling interval is clamped to 5s-5min, preferring the server `next_poll_after`; sync
  failures back off exponentially from 10s.
- One batch syncs the current ticket of all non-terminal tasks. A queued ticket turning ready sets
  `schedulable=true` and requests a scheduler wake; a queued ticket turning expired auto-retakes; a
  paused ticket does not auto-retake and waits for the user's Continue; `not_found` is ignored.

### 8.3 Terminal settle outbox

- Terminal write and server settle are separate, so a network error does not block the local
  completed state. Terminal tasks without `settled_at` are re-reported repeatedly.
- A settle 4xx is treated as no longer needed/possible and acked locally; network errors and 5xx keep
  the outbox. The settle API is designed to be idempotent.

### 8.4 Multiple window Hosts

Each window Local Host may start its own sync loop against the same SQLite. One Local Host can serve
several workspaceKeys; the workspace service scope does not map to a separate Host process. Repo state
writes and server APIs are idempotent where possible, so state is not corrupted, but duplicate
status/settle requests occur; there is no leader election or globally unique sync owner.

## 9. Scheduler, Main, Host and Session

### 9.1 Scheduler

- Reuses the existing utility process, with separate Off-Peak message types, Repo table and state
  machine. Ticks every 20s; the cron misfire skip rule does not apply. Startup runs
  `recoverInterrupted` first. `claimDue` claims only `queued + schedulable`, FIFO by `queued_at`.
- The in-flight set releases claims on exit; late results settle by task id only, independent of
  in-memory context.
- Host missing, busy or channel temporarily unavailable are transient: exponential backoff from 30s,
  capped at 15min. A permanent config error goes straight to failed. The terminal guard drops late
  dispatch results so cancelled/completed/failed are not overwritten.

### 9.2 Main routing

Routes the scheduler's `OffPeakRun` to the workspace's host, returns the host's `OffPeakRunResult` to
the scheduler, receives the host's scheduler wake request, and keeps session, ticket, queue and
snapshot state out of main.

### 9.3 Host dispatch

- The Off-Peak runtime initializes lazily, reusing the host's credential, provider, coding-plan and
  task services.
- First dispatch: read the workspace default model, explicitly create a deferred session with the
  user model, then send the original prompt. Continuation: resume the original session and send the
  fixed continuation prompt.
- Every segment builds a new `turnRuntimeModel` with the ticket id written to a header; the terminal
  outcome is subscribed by input/trace id and files changed are counted best-effort when done.
- Outcome `success` -> completed; `stopped` -> cancelled; others -> failed; a failure carrying the
  ticket-expired marker is not terminal and goes through re-take and continuation instead.

### 9.4 Multi-turn conversation logic

```text
Task row T (stable)
  ├─ Ticket A ── automatic turn 1 ──┐
  ├─ Ticket B ── resume turn 2 ─────┼──► one conversationId / one sessionId
  ├─ User queued prompt ─────────────┤    persistent user model
  └─ Ticket C ── resume turn 3 ──────┘    idle provider only per automatic turn
```

Many tickets, but one task and one session. Ordinary conversation between and after automatic turns
reuses that session; the resident provider is the user's workspace model and idle-plan is only a turn
overlay. A user message sent while the agent is busy follows the existing session queue and creates no
separate Off-Peak task queue.

## 10. Gray release, plan and quota gates

- **Client config gray release** (`configs.offPeak`): `enable_offpeak_task === true` and a non-empty
  `allowed_models` (the latter superseded by Built-in provider models since 2026-08-22) must both hold
  to expose creation; entering the screens force-refreshes the client config. The config controls only
  product exposure and the idle model whitelist, no longer a static free quota.
- **Coding Plan judgment:** the host resolves redacted support exactly by the current provider family
  / OAuth mode / selected connection key; the renderer no longer broad-scans the provider registry.
  ZAI personal, BigModel personal and BigModel Team are supported; Start Plan, API Key mode,
  unselected, login-provider identity mismatch and disabled/stale connections are excluded. With no
  suitable plan the button is locked and a click shows an info toast (about 8s, top-right, with an
  executable Upgrade action). The Automations form and the New Task template entry reuse the same
  support and verify it still matches the current selection.
- **Server live quota D39:** `GET /ticket/availability` is an instant snapshot; creation opens only
  on a successful request with `canTakeNumber=true`; false, loading, unknown or failed all gray it out.
  The UI schedules a refresh at `nextTakeAt + 100ms`; the real POST `/ticket` stays the final
  authority; a 3103 refreshes the snapshot but never writes "quota exhausted" into local config
  permanently.
- **Superseded D36:** an intermediate version implemented a static `limit.max_tasks/sliding_window`
  config with local `createdAt` prejudgment (and a matching E2E); the final code uses the server
  availability. Do not treat D36 as current when reading commit history.

## 11. Mock gateway and development verification

Behavior:

- Default fixed port `45197`, overridable by env; when several hosts race, the later starter hits
  `EADDRINUSE` and reuses the existing gateway.
- State advances lazily by access clock: queued -> ready -> active -> expired/settled; re-taking the
  same task expires the old ticket.
- Supports availability, take, batch status, settle and messages; can inject the first N 429/3105
  responses, the first N take 3103 responses, and an availability block. The first successful messages
  request activates a ready ticket.
- Either a fixed response for fully offline tests, or a proxy to the real personal Coding Plan
  upstream. Proxy mode really consumes the user's Coding Plan key and is for development/demo only;
  it strips hop-by-hop headers and returns 502 on upstream failure.

| Variable                                   | Effect                                         |
| ------------------------------------------ | ---------------------------------------------- |
| `ZCODE_OFFPEAK_MOCK`                       | enable the mock                                |
| `ZCODE_OFFPEAK_MOCK_PORT`                  | override the fixed port                        |
| `ZCODE_OFFPEAK_MOCK_READY_DELAY_MS`        | queued -> ready delay, default 15s             |
| `ZCODE_OFFPEAK_MOCK_READY_TTL_MS`          | validity of an unused ready, default 5min      |
| `ZCODE_OFFPEAK_MOCK_ACTIVE_MS`             | active duration, default 3h                    |
| `ZCODE_OFFPEAK_MOCK_QUEUE_429_COUNT`       | first N messages return 429/3105               |
| `ZCODE_OFFPEAK_MOCK_QUOTA_COUNT`           | first N takes return 3103                      |
| `ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS` | availability temporarily blocks taking numbers |
| `ZCODE_OFFPEAK_MOCK_RETRY_AFTER_S`         | Retry-After, default 5s                        |
| `ZCODE_OFFPEAK_MOCK_NEXT_POLL_S`           | next_poll_after, default 5s                    |

The WDIO management flow sets the ready delay to 60s so a task does not execute ahead of UI
operations; the quota pre-gate spec sets the availability block to 1 hour.

## 12. UI changes (MR Head snapshot; current UI rules are in `spec.md` §5)

- **Automations main view:** at MR Head the view had `All / Scheduled / Idle-time task` tabs (the All
  mixed overview was later removed by D47); idle tasks as a two-column card grid; sort priority
  running -> awaiting approval -> queued -> paused -> failed -> completed -> cancelled, newest first
  within a state; per-state menus (Pause, Continue, Cancel, Delete, Go to session); queued shows
  `#N in queue` and paused `#N Paused`. The large diff of `AutomationEditView.tsx` is mostly format
  reflow and shared project-option wiring, not a rewrite of page business logic.
- **Create/edit form:** project limited to local workspaces open and available on the desktop;
  title and Instructions required; permission reuses the four modes build/edit/plan/yolo (UI default
  constant `build`); model limited to the idle-plan models of `allowed_models`; GLM-5.2 shows
  `max/high/nothink` with default `max`; both the create page and Automations page mirror the global
  keep-awake switch; leaving a dirty draft asks to discard; the first non-yolo submit shows a
  full-access hint that does not block submission; queued/paused editable, running/terminal locked,
  an existing task's project cannot change.
- **History:** 0 or 1 aggregate row per task; hidden without `startedAt` or with `historyDeletedAt`;
  completed -> Succeeded, failed -> Failure, cancelled -> Skipped, other started states -> In
  progress; duration shows at least 1 minute; row actions Go to session and Delete history (no
  confirmation/Undo, tombstone only).
- **Sidebar and New task entry:** the desktop grouped sidebar adds a collapsible `Idle-time task`
  system group aggregating tasks across projects with a count; clicking a task with a session enters
  the session, otherwise returns to the matching Automations item. The New task empty state adds an
  idle-time banner and template cards that carry a pending draft to the create page. Closing the
  banner is kept only in the current renderer session, not persisted across launches.
- **Notifications, dialogs, toasts:** desktop-local only, listening to edge changes of completed,
  failed and awaiting_approval for system notifications; the first load only builds a baseline and
  never replays history; notifications dedupe by task/status; cancelled does not notify; the awaiting
  notification code existed but was unreachable at runtime. ConfirmDialog gained compact,
  destructive, close control and disabled-shortcut options; Toast gained top-right, info/warning,
  action and dismiss variants for plan and risk hints.
- **i18n and test ids:** English and Simplified Chinese strings for idle-time tasks, states, errors,
  form, History, quota and keep-awake; `IntlProvider` and the locale shape synced; shared test ids
  for Off-Peak pages/E2E.

## 13. Keep Awake final semantics

The early implementation started/stopped the blocker on "switch on and active task count > 0"; the
MR's final commit made it a global switch:

```text
AppSettings.keepAwakeWhileRunning
          │
          ├─ false ─► stop powerSaveBlocker
          └─ true  ─► start("prevent-app-suspension") immediately
                       (independent of whether an idle-time task is running)
```

Default false. General Settings, the Automations banner and the create/edit page show the same
setting. Desktop startup and setting updates sync `powerSaveBlocker` immediately. The scheduler still
reports the active count but main's count callback no longer decides the blocker. It only prevents
automatic app/system idle sleep, not lid close or user-initiated sleep.

## 14. Desktop / Web / Mobile remote boundary

- `IOffPeakTaskService` was added to the common accessor and remote service client to unify the
  service contract; this does not open the product to mobile remote.
- Mobile `/remote` hides Automations (a stale route falls back to chat); desktop remote workspaces
  hide idle tasks and the sidebar group; the create project selector offers only local open
  workspaces.
- No separate remote Agent runtime, local host or SSH/WSL/Docker session was added. The relay's
  business duties are unchanged and no task/queue/snapshot state went into relay/main. Desktop
  dispatch explicitly uses `desktop-continuous` and does not bypass the mobile `web-remote-replayable`
  recovery boundary.

## 15. Test coverage and verification state

| Layer                          | Coverage                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| adapter retry                  | 9 cases of 429/3105/3102, Retry-After, generate/stream boundary, ordinary provider isolation    |
| Repo                           | 16 cases of table creation, state guards, claim, recovery, continuation, History, settle outbox |
| Service                        | 10 cases of create, pause/continue, sync, re-ticket, cancel/settle, error routing               |
| Server client/mock             | 7 cases of interface parsing, envelope, null position, availability, state advance, error codes |
| Runtime model                  | 5 cases of dual credentials, provider construction, user model choice, multi-provider fallback  |
| Client config/gray             | 5 cases of config switches, allowed models, availability fail-closed/refresh                    |
| End-to-end service integration | 3 cases of mock take -> ready -> dispatch/continuation loop                                     |
| Scheduler settlement           | 3 cases of success/permanent/transient and backoff                                              |
| UI                             | project options, store concurrency, History mapping, toast, remote mobile hiding                |
| WDIO                           | two specs: create/manage flow, quota availability pre-gate                                      |

Conversation catalog: `docs/conversation-session-case-catalog.md` gained OP01-OP09; the coverage
matrix registers the off-peak scenarios and boundaries; the GUI cases OPF/OPA/OPR/OPB stay planned;
OPP is written but the matrix still records it as pending execution in a target environment; the
service mechanism covers OP02/OP04/OP07.

What not to over-read: E2E validates UI management and service gating, not real production off-peak
scheduling, real plan billing or natural 3-hour expiry; the mock upstream proxy mode uses the user's
own Coding Plan key and does not prove the online idle-plan billing chain; awaiting approval had no
production event wiring, so the existing UI/notification does not mean it works end to end;
pending/planned items in the coverage matrix are still outstanding verification and must not be
described as full coverage.

## 16. CI, dev environment and docs

- GitLab CI: the workflow accepts API pipeline source, and the source conditions of the manual
  conversation E2E, legacy manifest, sandbox upload/preload jobs also allow API. Not coupled to the
  Off-Peak domain logic.
- `mise run dev` adds `ZCODE_DATA_BASE_DIR={{env.HOME}}/.zcode-dev-home`, isolating dev desktop data
  from the default `~/.zcode` production data; docs and the root build script test were synced;
  `pnpm dev:desktop:test` semantics were not changed to the same entry. The custom OAuth scheme
  `zcode://` can still compete with an installed release build, which a separate data dir cannot
  solve.
- Docs: `spec.md` (product semantics, state machine, provider, UI, History), `decisions.md` (D22-D39
  trade-offs), `tech-design.md` (data, process, interfaces, sequences), `implementation-notes.md`
  (final key-file map, model restoration, integration notes), `glossary.md`, `table-design.html`
  (tabular audit, risk and lifecycle report), conversation catalog/coverage matrix, and the
  scheduled-tasks main view doc.
- The MR Head's `tech-design.md`, `glossary.md` and early ADR sections mixed "planned/not implemented",
  register/per-task GET, 3001, D36 static limit and approval-switches-provider semantics. The
  2026-07-22 follow-up aligned tech design/glossary/spec to the current code and stated the ADR
  supersession rule at the top of `decisions.md`; approval-switches-provider stays marked as
  unimplemented rather than rewritten as done.

## 17. Plans replaced or repeatedly revised inside the MR

| Topic                        | Intermediate state                                                    | MR Head final state                                                          |
| ---------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Quota prejudgment            | D36 `limit.max_tasks/sliding_window` + local createdAt                | D39 server availability snapshot + POST final authority                      |
| Keep Awake                   | blocker only when switch on and active count > 0                      | blocker whenever the global switch is on                                     |
| Session model                | first creation might land on the first provider in sort order         | workspace default -> lastUsed -> current, full provider/model kept           |
| Temporary provider lifecycle | restore timing after a turn risked queued messages crossing providers | restore and clear the turn overlay before ready/queue drain                  |
| ticket expired code          | early 3001                                                            | 3102 formal, 3001 kept for compatibility                                     |
| UI                           | several rounds of Figma alignment                                     | create composer, two-column cards, History, edge and locked states converged |
| Interface-count wording      | four interfaces                                                       | four ticket JSON endpoints + one messages endpoint                           |
| Run now                      | kept in the early plan                                                | v1 removed the run-now entry                                                 |

## 18. Known gaps, risks and tech debt

### 18.1 Functional gaps

1. `awaiting_approval` was not wired from agent permission events into the production chain (later
   removed by D44).
2. Approval switching to the user provider, and the "continuing will use your own plan quota" hint,
   were not implemented.
3. ~~UI and runtime Coding Plan support matrix mismatch.~~ Unified by D40 as the selected credential
   snapshot covering ZAI personal, BigModel personal and BigModel Team.
4. History offers no ticket/segment-level audit.

### 18.2 Consistency and recovery risks

1. A successful POST ticket followed by a failed SQLite insert yields an orphan server ticket.
2. Delete physically removes the row after a settle network/5xx failure, losing the outbox retry
   basis.
3. Sync does not auto-retake on `not_found`; only Continue re-takes.
4. If take unexpectedly returns active/expired/settled/not_found directly, a queued but unschedulable
   task may still be created; only some expired paths converge automatically.
5. Several hosts each start a sync loop and duplicate status/settle requests.
6. `next_poll_at` is a snapshot, not a per-task scheduler; the shared timer may be coarser than the
   field semantics.
7. UI `running` precedes real messages admission, so the state expression is imprecise during a 429
   wait.
8. The task row stores only the current ticket, so ticket history cannot be audited locally after
   re-ticketing.

### 18.3 Remaining semantic drift and fixed doc debt

1. Some source comments still say "status polling triggers server promote"; the server in fact
   promotes by its own timer and client polling only observes.
2. The shared type comment says permission defaults to `default`, while the UI default is `build`
   (code-comment debt remains).
3. ~~tech design/glossary status headers outdated~~: changed on 2026-07-22 to an implemented
   code-fact snapshot.
4. 3001 remains only as adapter compatibility and historical ADR; current docs declare 3102 the
   formal code.
5. D36 static quota stays only in historical ADRs, explicitly superseded by D39; current
   spec/tech/glossary treat availability + POST 3103 as the current state.

## 19. Suggested merge acceptance checklist

- [ ] Product confirms whether `awaiting_approval` must be completed in this MR or explicitly
      downgraded to a later capability.
- [ ] If required, add the end-to-end state machine and quota hint for permission event -> awaiting
      -> approve/reject -> provider switch.
- [x] Team Plan is in the support matrix and reuses the existing runtime-key helper; ZAI/BigModel
      personal, Team and rejected states have matrix tests.
- [ ] Run availability -> take -> messages -> settle once each with real ZAI and Team credentials in
      a target environment.
- [ ] Assess compensation for orphan tickets and Delete losing the outbox.
- [ ] Define a unified retake/fail rule for `not_found` and unexpected initial take states.
- [ ] Decide whether to accept duplicate sync from several hosts or add a single owner.
- [x] Update stale doc headers and the interface/quota/3001-3102/approval-provider wording; the
      shared code comment on the permission default is tracked as code debt.
- [ ] Run the pending WDIO / real-service integration in a target environment to verify availability,
      ready, 429, 3102, settle.
- [ ] Confirm the CI API-source relaxation and the mise data-dir isolation really belong in this MR.
