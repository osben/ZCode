# Idle-time Task: Decision Records (rolling ADR)

> **Status: historical ADR, feature implemented.** This file keeps the evolution of D1-D52 in time
> order; early entries are not rewritten to the final design, and "decided" only means the conclusion
> of that moment. Current behavior is defined by `spec.md`, `tech-design.md`,
> `implementation-notes.md` and the code; Scheduled Automation stays a separate domain.
> Rejected alternatives and the original analysis text are dropped.
> Full history: `git show b8876e8b:docs/off-peak-task/decisions.md`

> Produced by grilling sessions. Each record: conclusion and the consequences that still matter.

### Current code reading index (2026-07-23)

- Server interfaces follow D26/D39: `availability -> POST /ticket -> POST /ticket/status -> messages
  -> settle`; D25's register/per-task GET is a historical shape.
- The formal ticket-invalid code is `400/3102`; `3001` remains only as adapter rolling-release
  compatibility and historical notes.
- Create quota follows the D39 availability snapshot + the 3103 of `POST /ticket`; D36's
  `limit.max_tasks/sliding_window` and local createdAt counting were removed from the final client.
- D44 explicitly does not adopt the Off-Peak-specific approval state machine of D11/D27:
  permission/elicitation goes only through the ordinary session, the aggregate stays `running`, and
  the same automatic turn keeps using the idle-plan overlay.
- The D33 per-turn overlay is implemented; a user prompt sent while the automatic turn is busy is
  drained after the resident user model is restored.

## D1 Billing model (decided 2026-07-09)

**Free pool. The product has no "balance" concept; the balance-guard chapter is void and the client
has zero balance logic.** Creation was to be authorized by tier quota (lite:1 / pro:2 / Max:3; see
D5/D6, later voided). The existing coding plan is quota-based (`GET /api/monitor/usage/quota/limit`,
percentage); the client has no ¥ balance API.

## D2 Idle-window source of truth (decided 2026-07-09)

Server-delivered window table, client read-only cache; no exact ETA before a window API exists.
**Superseded by D21** (2026-07-10 doc-comment consensus): no window table is delivered, the client has
no window concept and instead polls a scheduling-authorization interface.

## D3 Window boundary semantics (decided 2026-07-09)

**Admission-threshold model.** A window only controls "when starting is allowed"; once started a task
runs to a terminal state without interruption. Cut: the window_paused state, "N windows consumed",
window-end snapshot continuation, and the "window paused" notification. (D26 later corrected "run to
terminal": the server enforces a 3h active time box.)

## D4 Anti-sleep (decided 2026-07-09, low priority)

A manual "keep awake" switch in Settings; no automatic powerSaveBlocker linkage this round; the
"keep plugged in" education card stays. Reason: macOS sleeps on idle, so a task window can pass while
the machine sleeps; `powerSaveBlocker.start("prevent-app-suspension")` prevents idle sleep but not
lid close. (D30-3 settled the final form: a single global switch.)

## D5 Task identity = delayed send on a conversation + queue lock (decided 2026-07-09)

**Voided entirely by D28** (the paradigm moved to an Automation sibling entity; run -> a new session,
no composer-lock problem).

## D6 Quota: tiers void, server limits scheduled task count (decided 2026-07-09)

The PRD's lite:1/pro:2/Max:3 and "1 per user per 24h" are void; the server limits the number of
scheduled (non-terminal) tasks per user and the client only handles "creation rejected". Corrected by
D18 (limit delivered by the server), then replaced by D26/D30-2/D39 (take-number quota).

## D7 Local scheduling: strict serial (decided 2026-07-09)

Downgraded by D18 to an execution policy and **overturned by D20**: the client imposes no concurrency
limit.

## D8 Full automation = bypassPermissions, no git handling (decided 2026-07-09)

Full automation maps to the existing `bypassPermissions`; sensitive pauses map to default + the
existing permission_request notification chain. No file-system sandbox (copy changed from "forced
sandbox" to "auto-approve all operations"). No automatic git baseline; the PRD's "commit a clean
version first" warning stays, responsibility rests with the user.

## D9 Missed window = defer, never discard (decided, semantic inference)

A queued task not scheduled because the app was closed or the machine slept stays queued with no user
action. This is the opposite of the automation scheduler's misfire-skip (`MISFIRE_GRACE_MS`), which
must not be reused. Holds naturally after D21 (no window to miss).

## D10 Notification action buttons = macOS best-effort, main path in-app (decided, engineering fact)

Electron Notification actions exist only on macOS, need signing and the "alert" style. Three buttons
(approve/reject/cancel) are only a macOS enhancement; the authoritative path is in-app, and a
notification click always navigates to the conversation. Reuses the `desktopNotifications.ts` chain.

## D11 Billing execution form = dedicated idle plan provider (introduced 2026-07-09)

> **Implementation status correction (2026-07-23):** idle plan per-turn injection is implemented; the
> derived rule of switching to the user provider / plan-quota hint after permission approval was not
> adopted by the final code and is explicitly cut by D44.

The "free pool" lands as: during execution an idle task uses a user-invisible dedicated provider (idle
plan, Start-plan-like). The original derived rules (approved sensitive tasks continue on the user's
own paid provider with a "will use your own plan quota" prompt; "run now" likewise) were refined by
D27 and then dropped (D32, D44). Switching is client-only logic; the server is unaware.

## D12 Sidebar "in progress" group = per-workspace display (decided 2026-07-09)

Voided by D30-5 (cross-project Group-view system group).

## D13 Multi-end boundary = desktop initiates, mobile read-only (decided 2026-07-09)

Later narrowed by D37-3: mobile `/remote` hides Automations completely.

## D14 "Expected completion time" field redefined (decided 2026-07-09)

The three-option user choice and the due reminder are cut. Weakened further by D21: with no window
table the submit dialog and status bar read "waiting for idle compute" and make no start-time promise.

## D15 Running across window end = lock idle plan until terminal (decided 2026-07-09)

Ownership guarantee: an idle plan task is admitted by the server as "started within the window" and
not rejected for crossing the window end. D19: the lock is a provider-ownership and admission
guarantee, not a no-queue guarantee. **Corrected by D26 (2026-07-14):** the server's active hard cap
is 3h; crossing 3h = re-take with the same task_id + resume continuation.

## D16 Idle plan integration = reuse the Start plan mechanism (decided 2026-07-09)

A built-in invisible provider, released by the server; the client reuses Start-plan-style
infrastructure and adds no task-level temporary credential delivery chain.

## D17 Server status = all three pieces new (confirmed 2026-07-09)

Window table / create auth + settle / idle plan release did not exist; the client mocked the API
contract draft. Restructured by D18.

## D18 Queuing belongs to the server; client only attempts and handles responses (decided 2026-07-09, corrects D6/D7/D17)

The server carries the queuing core: a global idle-time task pool with cross-user FIFO and admission
of some concurrency by free resources. The client carries no queuing logic and only: creates (limited
by the delivered cap; later replaced by the take-number), attempts execution for its earliest queued
task in the window, and handles queue-related responses (queued -> stay queued and back off;
admitted -> running). The position display becomes real. Open questions then resolved: FIFO = up-front
registration (D25), terminal settle (D22), mid-run queuing (D19).

## D19 Every in-task request may be re-queued (decided 2026-07-09)

After admission **every model request may be re-queued by the server**, which on a best-effort basis
prioritizes in-flight tasks and keeps one session's requests running continuously. Client form:

- Queue handling converges in the **idle plan provider adapter** (Retry-After + backoff), transparent
  to the agent runtime; the loop only sees "this response is slow".
- No new state-machine state: the task stays running; the detail status bar may temporarily show
  "waiting for idle resources (position N)".
- Queue waiting **does not count** toward the "consecutive API failures" failed judgment, and the wait
  has no cap; only real errors terminate. User cancel aborts the waiting retry loop.

## D20 Concurrency is controlled by the server, no local serialization (decided 2026-07-09, overturns D7)

A user can have several idle tasks running concurrently; how many is decided by the server. The
client dispatches all queued tasks in queue order; single-task dispatch stays single-flight
(claim transaction). No worktree isolation: file-conflict risk equals manually running several
conversations. Future plan-tier concurrency is a server policy.

## D21 No window concept in the client: polling authorization replaces the window table (decided 2026-07-10, replaces D2's window table)

The client does not judge peak/off-peak and stores no window table; it polls a scheduling
authorization only while non-terminal idle tasks exist. The D3 admission-threshold spirit is kept
(the threshold moves from "time window" to "server authorization"); UI copy is uniformly "waiting for
idle compute". Replaced in form by D25/D26 (ticket status).

## D22 Terminal settle = explicit settle report + silent-timeout backstop (decided 2026-07-13)

An idempotent settle report with an outbox pattern: report on terminal, `settled_at` records the ack,
re-report with the poll cycle, scan at host startup. The server frees the queue/active set and quota on
receipt; silent-timeout reclaim stays as a backstop. Settle is resource accounting, not billing.
Details in tech-design §7.7.

## D23 Host conversation locked in non-terminal states + provider bound to run scope (decided 2026-07-13)

**Superseded by D28/D30-9:** the composer lock is void (the run session is an ordinary conversation).
What survives is "provider is bound to the run scope": the idle plan selection is injected only with
this dispatch and not persisted into session config, so a follow-up message or post-terminal chat must
not keep burning the free pool (implemented by D33).

## D24 Long-wait strategy: short clamp x unlimited probing, relying on Retry-After (decided 2026-07-13)

The client never sleeps long (the server confirmed 2026-07-14 that 429 returns `Retry-After`; the
carrier is HTTP 429/3105, not a custom response header):

- **Rule 1 (abandon first dispatch):** a queued first request with Retry-After > `max(10 min, current
  pollInterval)` abandons this dispatch and leaves the task queued for the next authorization.
  (Later D26/spec §3 dropped the abandon-dispatch state machine: a ready ticket waiting until TTL
  expiry is re-taken uniformly via 3102.)
- **Rule 2 (single clamp x unlimited probing):** while running, a single wait = `min(Retry-After,
  5 min)` with unlimited idempotent probes (3h is about 36 probes), so freed resources are caught by
  the next probe. Clamp and Retry-After parsing reuse the `bigmodel-business-error-retry` logic;
  **budget exemption is a new switch**: the new retry reason `offpeak_queued` bypasses the unified
  retry budget (otherwise the current behavior fails after four or five probes).
- **Rule 3:** the UI shows retry hints honestly; cancel aborts the wait timer.
- **Two server obligations:** express hour-level gaps with the coarse valve (schedulable=false + a long
  poll interval), not "admit then hour-level Retry-After"; a queue response must return before the
  request is accepted (zero model side effects) and an SSE stream must not turn into queuing midway.
- Implementation:
  `apps/zcode-cli/packages/adapters/src/model/{failure-inspection,failure-classifier,runner-retry}.ts`,
  see tech-design §4.3.

## D25 Server contract converged to four task-lifecycle endpoints (decided 2026-07-13, replaces D21's global poll)

> **Historical interface shape, replaced by D26.** `POST /register`, `GET /:taskId`, 409 and
> `maxTasksPerUser` below are not the current client contract.

Take number (up-front registration; FIFO order recorded on the server, so forged queuedAt and
multi-device bypass disappear) -> poll per-task (`status + schedulable + queuePosition +
nextPollAfter`, schedulable = window open + turn reached) -> `POST /messages` -> settle. Consequences
carried forward: the global poll and the `off_peak_poll_state` single-row table are dropped; the
schedulable/queue_position/next_poll_at snapshot lives on the `off_peak_tasks` row; submission becomes
a failable round trip, so the UI needs a failure state; concurrency control = how many tasks the
server flips to schedulable. **Replaced by D26** (register -> `POST /ticket`, per-task GET -> batch
`POST /ticket/status`, schedulable -> server ready state).

## D26 Server v2 contract alignment (decided 2026-07-14, corrects D3/D9/D15/D24/D25)

Against `zcode-server` feat/off-peak `off_peak_design.md` (v2): the server is an admission system with
strict time boxes, unlike the "run to terminal" assumption.

1. **Two IDs (task_id / ticket_id).** The client submits its own stable `task_id`; the server takes a
   number and generates a Snowflake `ticket_id`; status/settle/messages use ticket_id. The local table
   has a `server_ticket_id` column, backfilled on take and updated on re-take.
2. **Two-axis state machine.** Server admission `queued -> ready -> active -> expired/settled`; client
   execution `queued/running/terminal` (and paused, D30). Mapping: **schedulable = server ready**,
   **running = server active**, client terminal -> settle -> server settled, server expired -> trigger
   continuation or failure.
3. **The low-peak window is on the server, the client still has no window concept (D21 holds).**
   `queued -> ready` is promoted only inside the server's off-peak window (default 00:00-08:00 +
   12:00-14:00 Asia/Shanghai, crossing midnight supported); outside it a number can be taken and the
   position queried but not promoted. Ready/active tickets are unaffected by window end. Corrects D9:
   missing a window = wait for the next one (not discarded), but ready 5min and active 3h are hard
   timers.
4. **3h cap + automatic re-take continuation.** Active is hard-capped at 3h with no sliding renewal;
   after expiry messages receive `400/3102` (corrects D15/D3). The same task_id may take numbers
   multiple times. The client continues automatically: active expiry / `400/3102` -> re-take with the
   same task_id -> back to queued awaiting ready -> resume the same session -> agent loop finishes ->
   settle. To the user it is one task alternating running/waiting; each 3h segment is one ticket.
5. **Interface/header alignment (replaces D25's shape).** `POST /api/v1/off-peak/ticket {task_id}`
   (may return ready directly); batch `POST /api/v1/off-peak/ticket/status {ticket_ids:[...<=100]}`;
   `POST /api/v1/off-peak/ticket/:ticket_id/settle` (JWT only, no body);
   `POST /api/v1/off-peak/anthropic/v1/messages` with `Authorization: Bearer <jwt>` +
   `X-Coding-Plan-Api-Key: <raw key>` + `X-Off-Peak-Ticket-ID: <ticket_id>`, native Anthropic body.
   The idle plan provider = a provider whose baseURL is that messages endpoint with auth JWT +
   coding-plan key; the server holds the upstream key. Models are whitelisted by `allowed_models`, body
   <= 10MB.
6. **Error code mapping v3 (server doc 2026-07-16, corrects v2's 3001).** `3101/403` no valid coding
   plan -> block submit; `3103/429` take-number quota (+`next_take_at`, absolute time, not
   Retry-After); `3105/429` model concurrency full -> **with `Retry-After`**, back off per D24
   `min(Retry-After,5min)` within the 3h budget; `3102/400` ticket unavailable (expired/settled/missing/
   not the owner) -> **triggers continuation re-take, not an ordinary error**; `3006/400` model not
   whitelisted -> pre-validate with allowed_models; `3011/499` client cancel -> expected;
   `2001/2002/2007/2010` (500) dependency errors -> transient backoff. **The real re-queue/rate-limit
   signal is HTTP 429/3105 + Retry-After, not the early-imagined `X-OffPeak-Queue` response header.**
7. **Client work:** supply `X-Coding-Plan-Api-Key` (the user's coding plan provider raw key); keep
   batch polling to drive promotion (the server has no resident scheduler; a status query triggers
   Promote); maintain task_id <-> ticket_id and store server_ticket_id.

(ready-5min first-shot contention / shortening next_poll_after: out of scope this round.)

## D27 Closing confirmations (decided 2026-07-14)

> **Implementation status correction:** model whitelist, take-number on submit and expiry re-take are
> done; the Off-Peak-specific "switch to user provider after approval / reject-and-skip" state machine
> was not adopted by the final code, see D44.

- Model: user selectable + pre-validate with allowed_models before submit (server exposes
  `allowed_models`; 3006 as backstop) - resolved 2026-07-15 via D31.
- **Take a number on submit:** confirming adds to the queue with `POST /ticket`, taking a number and
  showing position even off-peak, but not promoting to ready.
- **ready-5min expiry = automatic re-take with the same task_id**, same as active 3h expiry (any
  expired -> same task_id re-take and continue).
- `files_changed` reuses the existing task diff (checked in MR4). **Settle only settles the current
  ticket**: an expired old ticket is already naturally terminal on the server.

Server/product alignment list: 1) document the `Retry-After` on 429/3105; 2) ~~expose allowed_models~~
resolved by D31; 3) actual relaxed value of `take_number.limit` (multiple takes for one task_id
confirmed).

Pre-start spikes (fact checks, not decisions): `session/resume` continuation across tickets +
`updateRuntimeModelConfig` mid-session provider switch; whether the client can read the raw Coding
Plan API Key; whether `bigmodel-business-error-retry` can carry 429+Retry-After. Conclusions in
tech-design §11.

## D28 UI paradigm = Automation sibling entity, Figma is the source (decided 2026-07-14, overturns D5/D23's conversation paradigm)

> **Correction (2026-07-28):** the "Automations Tab (All / Scheduled tasks / Idle-time task)" was
> narrowed by D47 to two tabs; the rest stands.

Per the Figma page "Automations & Idle-time tasks", an idle-time task is an **entity under
Automations**, not a "delayed send on a conversation":

- **Create:** a full-page form in the Automations main view (Task title + Instructions + project + Ask
  for approval dropdown + model + Idle-time slot selection) with Settings/History tabs; fully reuses
  the feat/cron scheduled-task creation paradigm.
- **List:** cards with queue-position badge and action menu.
- Entries were at least four (Automations button, New task banner + template cards, in-conversation
  429/quota toast guidance, Create via chat); **the PRD's composer moon switch does not exist**
  (entries narrowed by D30-4, Create via chat restored by D49).
- Voided: D5, D23's composer lock/takeover semantics, the sidebar moon status icon, per-conversation
  confirmation dialog, "remember preference 30 days". Kept: D26's 3h continuation, the endpoint
  contract, D24 wait strategy, D27 billing boundary (acting on the run execution layer).
- Later UI details take that Figma page as the single source; spec §5 follows the design.

## D29 Design interaction rulings, batch 1 (grilling 2026-07-14)

> **Implementation status correction:** the permission dropdown stays; "approve = takeover = switch to
> user key" and the dedicated waiting state were not adopted, see D44.

1. **One-shot entity:** create = take number and queue -> terminal when done; no Run again (a settled
   server ticket cannot re-take the same task_id; running again = a new task).
2. **History = one aggregate row for the whole execution;** 3h continuation segments are transparent;
   Go to session jumps to the single session.
3. **Pause/Continue (plan A + manual Continue):** Pause = the client stops dispatching, the ticket
   keeps queuing on the server; a paused ticket that reaches ready unclaimed expires after 5 min and
   **stays Paused, no auto re-take**; Continue: a live ticket resumes dispatch (zero cost), a dead
   ticket is manually re-taken to the queue tail. Quota use is always triggered by an explicit user
   action. (The Pause tooltip/confirm UI was changed by D46.)
4. **Permission default = Ask for approval** (safety first), with an in-form warning "unattended during
   idle time; operations needing confirmation pause the task until you respond"; all four modes open
   (Ask/Edit automatically/Plan/Full access, mapped to the existing ZCodeTaskMode).
5. Adopted from the design without dispute: create button grayed at the limit + tooltip "Free tier
   limit reached"; non-coding-plan users get a locked button + "coding plan users only"; several tasks
   queue at once with positions; model dropdown = allowed_models whitelist.

## D30 Design interaction rulings, batch 2 + paradigm follow-ups (grilling 2026-07-14)

1. **Est. wait cut:** cards show only the position (#N in queue); the client makes no time estimate.
2. **Quota semantics:** distinct task_ids within a rolling 24h <= the server-configured number
   (including Paused, no refund); multiple takes of one task_id are not double counted. (Tightened by
   D36/D39: idempotent exemption holds only while the latest ticket has not expired.)
3. **Keep awake = a single global switch** mirrored in the list banner / create page / Settings General;
   implemented as `keepAwakeWhileRunning` (final behavior: the blocker follows the global switch, see
   glossary).
4. **Entries converge to two:** the Automations main view button + the New task banner & template cards
   (template = prefilled create form). Cut: the in-conversation 429/quota toast guidance and Create via
   chat (the latter restored by D49).
5. **Sidebar:** Group-view system group "Idle-time task" (cross-project aggregate, count badge); not in
   the Project view; **D12 per-workspace void**. (Final contract: D48/spec §5.1.)
6. **Terminal cards** stay shown (Succeeded/Failed badge + time), deletable, never auto-cleaned; sort by
   `createdAt` descending only.
7. **Edit window:** queued/paused all fields editable; running and later locked (cancel only); terminal
   read-only; the discard-draft dialog follows the scheduled paradigm.
8. **D25 trade-off revision:** no longer pre-create a host conversation at submit; creation stores only
   form data + takes a number; **dispatch createTask creates a new session**, sessionId backfilled on
   first run, interrupt recovery still resumes the same session.
9. **D23 revision:** composer lock void; a user message mid-run follows today's busy queue behavior, but
   **a queued message must go through the user's own provider** (D23's "provider bound to run scope" is
   more critical than before; MR3 acceptance + spike).
10. **State machine gains paused** (user-initiated): queued <-> paused; a paused ticket expiring stays
    paused (D29-3); paused can be cancelled and edited.

Feedback items to design (Mico): drop Est.; reword the Pause tooltip; add the unattended-warning row;
design the missing states (running badge, terminal card styles, Paused-ticket-invalid hint);
design system notifications (completion/failure; waiting-for-confirmation later cut by D44); make
"free runs per 24 hours" follow the server config; the in-conversation light-traffic frame is void.

## D31 Client gray-release switch (decided 2026-07-15, aligned with server §11.1)

Idle-time entries are delivered through the **existing shared config interface** `GET
/api/v1/client/configs` (Authorization optional): the client reads `data.configs.offPeak`, **zero new
requests**; the existing consumers (`forceUpdateGuard.ts`, `bigmodelCodingPlanSubscriptionProvider.ts`)
are reused. Fields: `enable_offpeak_task` (master switch; false/missing/not hit = off) +
`allowed_models` (the model list for gray users; since 2026-08-22 superseded by the Built-in
provider's models). The config controls only exposure and model display and does not replace server
auth / off-peak judgment / ticket admission / whitelist validation (3006 backstop).

1. **Gray miss = fully hidden, gated inside the gray release:** Idle-time tab / create button /
   template cards / sidebar group are all not rendered; the "non-coding-plan gray lock" (D29-5) applies
   only after the gray release is hit. Exposure is two layers: gray on -> then coding plan.
2. **Effective-on criterion = `enable_offpeak_task === true`** and a non-empty model list (an empty or
   missing list is an incomplete config: hide, do not show an unsubmittable form).
3. **Gray flip midway: stock keeps running, only the create entry hides.** If non-terminal stock
   exists, the Idle-time tab/sidebar group still show it and run it to terminal (server ticket
   admission is the real authority); with no stock everything hides. A stock task whose model left the
   whitelist is not pre-judged; dispatch hits `400/3006` and uses the existing failure handling.

Spike addition: confirm the fetch timing of client/configs (forceUpdateGuard is a one-time startup
check); the gray refresh cadence may need a re-fetch when the entry opens.

## D32 "Run now" cut from v1 (decided 2026-07-15)

D30's card menu (queued = Pause/Delete/edit) and Figma have no "run now"; with the user confirmed:
**follow Figma/D30, v1 has no run now**; to run immediately, cancel the task and start your own
conversation. Cleanup: the billing-boundary table row, RPC `offPeakRunNow`, the migration-table
"queued -> dequeue" row, the "run now" trigger in the spec §3 takeover list.

## D33 Run-scope landing = per-turn runtimeModel injection (decided 2026-07-15, lands D23/D30-9)

Spike (tech-design §11) showed that setting a model on a session persists it in three layers (app cache
`runtimeModelConfigBySessionKey` / CLI `record.modelRuntime` / workspace catalog), so a user's busy
interjection and post-terminal chat would drain to the idle plan, violating D23/D30-9. Decided **(a)
per-turn injection**:

- Every dispatched sendPrompt carries the idle plan runtimeModel for that turn only; the session
  resident model, the three caches and the workspace catalog are untouched (`applyWorkspace:false`).
- The session resident model is always the user's own, so interjections and post-terminal chat
  **naturally** use the user provider with no switch-back timing.
- CLI runtime state keeps two layers: "session resident model" and "active turn temporary model".
  `ensureModelReady` may validate the active-turn temporary target but must not fall back to the user
  model because it is absent from the workspace catalog; this exception is authorized only by the
  in-memory active-turn marker and does not relax the catalog boundary for ordinary hidden models.
- The provider registry may hot-update during a turn. Every overlay/registry rebuild uses "latest
  workspace catalog + current active-turn runtimeModel"; never drop the temporary provider from the
  in-flight turn's later retries; only after the turn ends is the user model restored and the
  temporary provider cleared per the latest catalog.
- Apply, hot update, restore and cleanup enter the same session model-config serialization boundary;
  restore and cleanup precede ready/queue drain. If restoring the original model fails, the temporary
  credentials are still cleared and the workspace catalog's available model is the fallback, never a
  half state pointing at a deleted temporary provider.

```text
workspace catalog ───────────────┐
                                 ├─ latest catalog + active turn override ── model registry
sendText(turnRuntimeModel) ──────┘                              │
                                                               ├─ provider registry refresh: keep override
turn finally: restore user model ── clear active override ─────┴─ rebuild latest workspace-only registry
                                                               └─ release ready / drain queue
```

- Cost accepted: the agent service/CLI needs a per-turn runtimeModel channel that does not hit caches
  (the existing `ZCodeAgentSendPromptParams.runtimeModel` is not on the V4 sendText main path and
  writes caches after send).
- Companion engineering decisions: the server mock ships as an **in-process mock + env switch** (the
  real HTTP client follows the contract; the switch flips to the mock for a real-device walkthrough,
  integration just removes the switch); E2E is done in the same round.

## D34 Fill in the reasoning-depth field (decided 2026-07-16)

The domain model omitted `thoughtLevel` (automation's config surface is model + provider + mode +
thoughtLevel); Figma's create-form composer has the `Max` reasoning selector. **Add `thoughtLevel`,
aligned with automation;** provider is still not copied (idle always uses the idle plan, D26/D33).
Spans: shared types/create params, the `off_peak_tasks.thought_level` column, the OffPeakRun protocol,
host dispatch `setConfigOption("thought_level")` (same path as automation; per-turn provider injection
unchanged), the UI toolbar dropdown. Unset = workspace default (nothing sent).

## Leftover small items (settled with the batches)

- ~~queued actions = cancel / run now~~ replaced by D30's card menu and D32; failed is not auto-retried
  and can be manually re-enqueued (re-authentication).
- The detail page "compute consumed/remaining" fields are cut with the no-balance model.
- "Remember preference 30 days" would remember only the permission mode.
- The code domain is named `offPeak` (table `off_peak_tasks`); the branch name is unchanged.
- Balance-related copy such as "go to top up" is void.

## D35 Edge-state Figma frame audit (decided 2026-07-16)

1. **Implemented:** the discard-draft dialog (4889-1942); History tab as a table (Instructions/
   Triggered/Status/Duration + row menu, 4866-2819) with the create-state empty state "No history yet."
   (4866-3106); two-line permission dropdown with a selected check (4835-4974, reusing the main
   composer `mode.description.glm.*` copy); the top-right hint when full access is not enabled
   (4970-2055).
2. **Reactive limit gray = transitional (replaced by D38/D39):** with no quota API the "Free tier limit
   reached" gray was set only after a 3103 and cleared on the next successful creation; the mock
   gateway gained `ZCODE_OFFPEAK_MOCK_QUOTA_COUNT`.
3. **Non-coding-plan lock** was decided by the user on 2026-07-16 as a client judgment from the current
   registry (no waiting for a server entitlement field); lock takes precedence over limit gray; not
   flashing while the registry loads. **The qualification source of truth was replaced by D40** (broad
   registry scan diverged from the runtime credential; now the host resolves the selected connection
   and returns redacted support to the UI).
4. **Stay void:** the "exceeded queue time" auto-grouping and auto-put-back toast (4866-2175 local);
   the in-conversation light-traffic entry frame (4828-1642, D30-4); All-tab idle card Est. (D30-1).

## D36 Limit gray = configured quota + local record prejudgment (user ruling 2026-07-16, replaced by D39)

Superseded. It prejudged with `data.configs.offPeak.limit: { max_tasks, sliding_window }` (seconds) and
a local rolling-window ticket-take count; the final client deleted this. What survives as server fact
(authority: `zcode/zcode-server` `docs/off_peak_design.md` §11.1): counting is by the user's
`off_peak_tickets.created_at`, each successful ticket creation counts once; the idempotent exemption
holds **only while the latest ticket has not expired** (an expired-ticket Continue/re-take creates a
new ticket and counts, tightening D30-2); settle / ready expiry / active expiry never refund a slot; a
slot recovers when the ticket creation time leaves the rolling window. Local counting is inherently
inaccurate (re-takes consume quota without a new local row; multi-device is invisible), so 3103 stayed
the authoritative backstop.

## D37 Automations Figma difference closure (decided 2026-07-20)

Based on 12 Figma boards and about 49 left/right diffs as the UI source while keeping the established
scheduling and session semantics:

1. **Naming layers:** English UI `Idle-time task`, Chinese UI 闲时任务; technical domains `OffPeak*` /
   `offPeak*` / `OFF_PEAK_*` / `off-peak` / `off_peak_*`.
2. **Local project boundary:** creating anything in Automations lists only the local projects open and
   available in the current window, not recent/remote; the project cannot change after creation;
   existing remote tasks stay visible and manageable.
3. **End boundary:** mobile `/remote` hides Automations completely; desktop remote workspaces hide
   Idle-time.
4. **Card navigation:** the card's primary click always enters Settings/History; Go to session is an
   explicit secondary action.
5. **History stays one execution per task:** 0 or 1 row per task, no runs table. Shown after
   `startedAt`; in progress is uniformly `In progress`, terminals map to Succeeded/Failure/Skipped.
   Delete history writes only `historyDeletedAt`, deleting no task/session/execution fields, with no
   confirmation or Undo.
6. **Hint boundary:** the first non-Full-access submit shows a warning but creates immediately; a
   template click without subscription shows an 8-second Toast with Upgrade and a close X; the locked
   button keeps its Tooltip.
7. **keep-awake and quota:** keep-awake stays a global persistent setting that creation does not
   change (the quota part was replaced by D39).
8. **Acceptance:** 1440x960, dark, en-US, fixed sidebar and deterministic fixtures as the main
   baseline; light/zh-CN for semantic acceptance. Figma's multi-popover composite is split into
   independently reachable states; no screenshot matcher is introduced.

## D38 No up-front quota gray; 3103 is a single-create error (2026-07-21, replaced by D39)

With no read-only quota probe on the server and `client/configs.limit` only a static cap, the
reactive `quotaExhausted` (D35) and the local rolling count (D36) cannot give a reliable recovery
time. D38 removed quota from the disabled judgment (every click really requests `POST /ticket`; 3103
shows "Free tier limit reached", then the entry is clickable again, nothing persisted). Replaced
shortly after by D39 once the availability endpoint existed.

## D39 Server quota availability snapshot + exact recovery time (decided 2026-07-21)

Server `main` at `7d90055719ee6e6be3424a90441967e359618d4a` added the quota query contract:

```http
GET /api/v1/off-peak/ticket/availability
Authorization: Bearer <zcode-jwt>
X-Coding-Plan-Api-Key: <coding-plan-api-key>

→ { code: 0, data: { can_take_number: true } }
→ { code: 0, data: { can_take_number: false, next_take_at: 1783908000000 } }
```

`next_take_at` (Unix ms) is returned only when a new ticket cannot be created; it is computed from the
`created_at + window` of the ticket at the current `limit` threshold, so it stays correct after the
server lowers the limit. The result is only a call-time snapshot; concurrent requests may consume quota
afterward, so `POST /ticket` is final.

Client duties re-layered:

1. `client/configs` `offPeak` keeps only `enable_offpeak_task` and `allowed_models`; the unused `limit`
   field, its parsing and the local `createdAt` counting are deleted.
2. Entering Automations actively queries availability. `can_take_number=false` grays the create button
   early with a Tooltip showing the server `next_take_at`, re-queries at that time, and persists no
   `quotaExhausted` boolean.
3. A failed availability query is fail-closed per D43; the real creation is still handled by
   `POST /ticket` for the post-query race.
4. If `POST /ticket` still returns 3103 after availability was true, the UI shows this error and
   immediately refreshes availability; server 3103 is the final authority.
5. The new 3103 response carries the recovery time in `data.next_take_at`; the client tolerates the old
   mock's top-level `next_take_at` but never turns one error into an indefinite boolean.

```text
client/configs ──> feature exposure + allowed models
                         │
                         v
ticket/availability ──> create-button quota snapshot + next_take_at timed refresh
                         │ can_take_number=true
                         v
POST /ticket ─────────> final admission (a race can still yield 429/3103)
```

## D40 Coding Plan eligibility and credentials unified as a selected-connection snapshot (decided 2026-07-22)

D35's broad registry scan only answered "does the cache contain some usable plan", not "which
connection the current provider family selected". The old runtime resolver always read the personal
BigModel key, so the UI could allow ZAI/Team while take-number or the automatic turn still reported a
missing `codingPlanApiKey`; switching connections could mix the JWT, ticket key and turn key from
different moments.

**Eligibility, ticket APIs and the per-turn runtime share one host-side selected credential snapshot.**

```text
provider family + family mode + selected connection key
                         |
                         v
       exact connection classifier (Start/API Key rejected)
                         |
                         v
 selected provider registry entry / existing Team runtime-key projection
                         |
                         v
 OffPeakCredentialSnapshot { support metadata, JWT, codingPlanApiKey }
           |                         |                         |
           v                         v                         v
 sanitized UI support      availability/take/status/settle   per-turn model
```

The support matrix is fixed: ZAI personal Coding Plan raw key, BigModel personal Coding Plan raw key,
BigModel Team project runtime key (reusing the existing `${apiKey}.${secretKey}` helper). Start Plan,
API Key mode, unselected, active OAuth provider differing from the selected family, disabled, stale, or
selection/login identity changing during resolution are all rejected; never scan arbitrary cached
providers and never fall back to a personal key when Team resolution fails. The UI receives only
redacted metadata such as provider family/id/selected key.

The server `main@ec2b18daa01b8e1b801f0691ac22153c2e56c6db` verifier supports ZAI/BigModel by the JWT
login provider and treats `X-Coding-Plan-Api-Key` as an opaque credential checked for plan ownership,
so the three key shapes share the five-endpoint contract; the Start Plan JWT is not a Coding Plan API
key and is out of the matrix.

## D41 Home template navigation allows any Coding Plan (decided 2026-07-22)

A home template click only carries a draft into the create form; it takes no number and starts no
runtime. Applying D40's selected-connection gate there would treat users who have a Coding Plan but no
selected provider as "unsubscribed" and show the Upgrade Toast. The home navigation gate therefore
checks only whether the provider snapshot holds any non-system-disabled ZAI personal, BigModel
personal or BigModel Team Coding Plan (Start Plan not counted; a user manually disabling a provider is
not an unsubscribe and still counts).

```text
New task template click
        |
        +-- no Coding Plan --> Upgrade Toast + no draft/no navigation
        |
        `-- any Coding Plan --> write draft + enter create form
                                      |
                                      `-- submit still goes through the D40 selected-connection gate
```

D41 relaxes navigation only; it selects or switches no provider and does not let the runtime scan the
cache for a credential. The Automations create button, form submit, ticket API and per-turn runtime
keep D40; with no family/connection selected the form submit stays disabled.

## D42 Team Plan client transport works, test backend verifier still blocked (confirmed 2026-07-22)

In the tester's Windows test package `3.5.3-alpha.0@fc76b00d`, after switching to a full BigModel Team
org/project the Team project API Key prewarm returned `status=existing`, entitlement resolved to the
same org/project with `scope=team`, and Off-Peak availability reached the server Coding Plan
middleware. Test backend logs showed the verifier calling the subscription dependency got
`3101 coding plan is required`, wrapped as `HTTP 500/code 2007`. This rules out "the client sent no
key" (that would be `403/3101` directly at the middleware). The `POST /ticket HTTP 429` in the same
round had body_size=0 in the access log: an independent global HTTP rate limit, not the `3103` quota
with `next_take_at`. Decisions:

- Do not fall back to a personal BigModel key or present Team as a client-side fix; the backend must
  add a Team credential verifier branch or let the subscription dependency accept Team project runtime
  keys.
- The client shows a quota error only for an explicit `code=3103`; `2007` and a bare `429` show
  temporarily unavailable.
- The ticket client adds standard origin/request-id headers and logs path, HTTP/code, credential kind
  and request id at service `warn`; never JWT, API Key, secret or fingerprint.

## D43 Create admission becomes fail-closed (decided 2026-07-23, replaces D39's fail-open)

The user required that both "no eligibility" and "temporary dependency errors" block entry. Availability
is no longer a droppable quota optimization but the server admission confirmation: creation is allowed
only when selected-connection support succeeds and the latest `GET /ticket/availability` successfully
returns `can_take_number=true`.

```text
selected connection support
        |
        +-- unsupported / unresolved ----------------------> blocked
        |
        `-- supported --> GET /ticket/availability
                              |
                              +-- true --------------------> create allowed
                              +-- false + next_take_at ----> blocked, re-query at the time
                              `-- loading / network / 5xx -> blocked, retry after refresh
```

A temporary dependency error is not written as a permanent eligibility conclusion but stays blocked
until the next successful refresh; manual refresh, re-entering the page or the `next_take_at` re-query
clears it. `POST /ticket` is still the final authority for the race between query and submit; a failed
create request also returns to blocked until availability succeeds again. New Task and Automations may
briefly mount together on navigation; their initialization must be single-flight in the shared store so
concurrent availability requests do not overwrite each other with a late rate-limit/success result.

## D44 Permission goes only through the ordinary session; the Off-Peak waiting state is cut (decided 2026-07-23)

Fact: the per-turn `runtimeModel` covers the whole automatic turn. permission/elicitation blocks tool
execution inside the ordinary session waiting for the user but does not end the turn, so subscribing to
the event and writing `awaiting_approval` cannot implement D11's billing switch and would only make the
Review card and dedicated notification promise a provider handoff that does not exist.

**The current runtime boundary is the product rule; no mid-turn provider handoff is added.**

```text
off-peak sendPrompt(turnRuntimeModel=idle plan)
        |
        +-- permission / elicitation requested
        |       |
        |       +-- ordinary session shows it and collects the response
        |       `-- off_peak_tasks.status stays running
        |
        +-- approve / deny --> the same automatic turn continues, still using the idle plan
        |
        `-- turn terminal --> restore the resident user model --> drain the user's queued messages
```

- Removed: the `awaiting_approval` domain state, the Repo write entry, the card Review display and the
  Off-Peak dedicated waiting-for-confirmation notification.
- A historical database holding the reserved value migrates it to `running` at initialization; startup
  recovery still treats running -> queued.
- The Ask for approval permission option stays; safety confirmation is done by the ordinary session.
- completed/failed stay Off-Peak aggregate notifications; permission/elicitation notifications belong
  only to the generic session chain.
- If product later requires "switch to the user provider after approval", a verifiable mid-turn
  runtime-model handoff must be designed first and the aggregate state reintroduced; restoring the UI/
  Repo shell alone is not allowed.

## D45 Idle automatic turns must not create scheduled tasks (decided 2026-07-23)

Both first run and continuation enter an ordinary session but the executor is a background automatic
turn; with the ordinary full tool surface a model could call `CronCreate` and spread one idle run into
later scheduled tasks without explicit user action.

**Every idle dispatch explicitly denies `CronCreate` at the sendPrompt turn scope.**

```text
first run createTask ──┐
                       ├─ sendPrompt(toolDenylist=[CronCreate], turnRuntimeModel=idle plan)
continuation resumeTask ┘
                              |
                              +-- CronCreate: not exposed in this turn
                              `-- CronList / CronDelete: stay available
```

- The denylist is sent with this prompt only, not written to the session resident config; ordinary user
  turns after the automatic turn are governed by the session's own policy.
- The cron automation's `automationId` marker is not reused: idle tasks and cron are sibling entities,
  and forging the marker would pollute cron session ownership, task aggregation and history semantics.
- First run and continuation take different paths before `sendPrompt` but must converge on the same
  idle-turn denylist so a resumed segment never re-exposes `CronCreate`.

## D46 Pause drops the second confirmation and updates the hint copy (decided 2026-07-28, replaces the UI part of D29-3/D30-2)

Pause no longer shows a second confirmation: choosing the menu item executes immediately; the trailing
info icon and Tooltip stay with the product-specified copy:

- English: `Tasks paused beyond the queue wait time will be placed back in the queue`
- Chinese: `暂停时长超过队列等待时限的任务，将会被重新放回队列。`

Only UI interaction and copy change; the ticket state machine is unchanged (the Tooltip is a simplified
user-facing note):

```text
queued -- Pause (no confirmation dialog) --> paused
                                  |
                                  +-- ticket not expired -- Continue --> resume dispatch
                                  `-- ticket expired     -- Continue --> re-queue
```

D29-3's runtime fact (a paused ticket is not auto re-taken; Continue resumes or re-queues by ticket
validity) holds.

## D47 Remove the All mixed tab; the main view keeps Scheduled / Idle only (decided 2026-07-28, narrows D28's three-tab wording)

Automations drops the "All" overview tab and lands on Scheduled tasks by default; Idle-time task is
still gated by D31. Derived constraints:

- The All-only shared mixed grid (two columns / 132px row height / 16px gap, idle first, hidden
  `Task created` heading) is deleted; there is no cross-type overview, and the two card types keep
  independent list semantics within their tab.
- When the gray release turns off, a selected Idle tab converges back to Scheduled (was All); when idle
  is not visible only the Scheduled tab remains and the action row still carries refresh and create.
- The keep-awake banner is a global switch (mirrors Settings "General"; powerSaveBlocker is not bound
  to idle active counts) and so benefits scheduled run sessions too: shown on both tabs - before the
  task cards in the list state, after the large empty card in the empty state, no longer bound to idle
  visibility.
- The `offPeak.tabs.all` copy key is deleted.

Implementation: `AutomationsTab` narrows to `"scheduled" | "idle"`; `resolveVisibleAutomationTabs` and
`resolveAutomationTabAfterOffPeakChange` follow this; the populated-list fidelity and tab contract
tests assert against this decision.

## D48 Sidebar idle group converges to first-class tasks-index rows (decided 2026-07-28, replaces the same-day virtual-id collapse / renderer sorting)

Background: the Idle-time sidebar group was an independent component borrowing only Scheduled's
TASK_GROUP_* visual classes; two user reports (no in-group drag, collapse-all not covered) exposed the
cost of "visually consistent, behaviorally dual track". After a morning patch with a virtual group id +
localStorage ordering, a grilling session converged fully. Core mechanism = copy cron: `offPeakTaskId`
becomes a persistent task-meta marker (not reusing cronAutomationId, D45), and
`ensureOffPeakGroupMembership` writes a real system group so the UI uses the native grouped pipeline.
Full contract in spec §5.1. Key rulings:

1. ~~Phantom rows keep queued visible~~ - **revised the same evening (D48-A): strictly copy cron;**
   queued/paused tasks are not in the sidebar before dispatch and the Automations main view is the only
   queue management surface. Basis (facts unknown at grill time): suppression has no single
   chokepoint (`fetchTaskListMembershipSets`' taskIndexItems feeds both grouped and flat lists, so
   suppression would be scattered over 5+ places); prefilling `sessionId` breaks the implicit "present
   = has run" contract (OffPeakHistoryTab Go-to-session gate, OffPeakTaskList card entry, etc.); the
   benefit is only a sidebar bookmark to Automations. The phantom-row option is "deferred" in spec §5.1;
   trigger = real user feedback asking for queued tasks to be visible in the sidebar.
2. **Scope downgrade:** accept the grouped view's open-workspaces-only scope; cross-project aggregation
   converges on the Automations main view; no query exception for one group.
3. **Membership copies cron's looseness:** can be dragged out/in, no closure guard; the marker follows
   the row, not the group.
4. **Unified archive:** closing a dispatched row = archive, no confirmation dialog; delete/cancel are in
   the Automations card menu (the old sidebar "confirm then cancel and delete" is retired).
5. **In-group sorting and persistent empty group copy cron;** the group-header "+" is the only
   difference (opens Automations; cron's draft-creating semantics are wrong for idle).
6. ~~Full suppression~~ void (nothing to suppress after the D48-A revision).
7. **Retirement and migration:** the virtual id mechanism, `zcode-off-peak-sidebar-order` and the
   projection dedupe are deleted; local collapse/sort preferences are reset (never shipped);
   stock migration is idempotent (sessions backfill marker + membership); `OFF_PEAK_DEFAULT_GROUP_ID`
   goes into shared next to `CRON_DEFAULT_GROUP_ID`.
8. No temporary feature switch; landed as three MRs (instrumentation -> atomic switch + migration ->
   test wrap-up), spec first.

**MR review revision (D48-B, 2026-07-28):** remote workspaces are explicitly out of idle-time support
(v1 is desktop-local only). Group writes and bootstrap membership backfill skip remote rows entirely -
stock remote rows may lack the `workspace_identity` column, so the remote judgment reads the primary key
`workspace_key`; otherwise backfill would recompute a local key from `workspacePath` and cross-write
membership (review CR-01). Also fills the `offPeakTaskId` stamping on the resumeTask normal snapshot
path, same semantics as the legacy branch (review SG-01).

## D49 In-conversation creation of idle-time tasks (decided 2026-08-24, overturns D30-4's Create-via-chat cut)

feat/offpeak_v2 restores "Create via chat": the user asks the agent in natural language to create an
idle-time task, aligned with the scheduled task's `CronCreate` paradigm - **a unified creation entry =
the OffPeak* and Cron* sibling tool families side by side**, the agent routing by semantics (tool
descriptions distinguish "scheduled trigger vs idle queue with no fixed run time"), the two systems
staying independent per D28. Three grilling rounds:

1. **Tool surface = `OffPeakCreate` + `OffPeakList` (read-only);** no update/cancel tools. The only
   edit entry: the chat turn-tail card -> the Automations idle tab edit form (D30-7 edit window
   unchanged; running/terminal are naturally read-only via OffPeakEditView's readOnly).
2. **Idle automatic turns deny `OffPeakCreate`** (symmetric with D45: an idle task creating idle tasks
   = free-pool self-amplification); `OffPeakList` stays available. Landing: the idle dispatch turn's
   toolDenylist grows from `["CronCreate"]` to `["CronCreate", "OffPeakCreate"]`.
3. **Cron automation automatic turns allow `OffPeakCreate`** (combined play: users can chain "scheduled
   task spawns idle task"). No local counting guard; the server quota is the sole authority
   (`POST /ticket` 3103, D38/D39 spirit). Trap: cron tools' `assertNotAutomationTurn` guards the
   opposite direction; OffPeakCreate must never be mixed into any copy of
   `AUTOMATION_MUTATION_TOOL_NAMES`.
4. **Parameters:** `title`/`prompt` required; `permissionMode`/`model`/`thoughtLevel` optional (the agent
   overrides on explicit user request); **defaults = full auto (yolo) / the last of `allowed_models`
   (assuming the server order's last ≈ newest and strongest) / highest reasoning level.** This is an
   **intentional fork** from the form defaults (Ask + allowedModels[0] + workspace default level,
   D29-4/D34): the tool path serves "say it and leave" unattended semantics - an Ask default would let
   the task hang on a permission confirmation at midnight, against idle-time's core value; the form path
   keeps safe defaults and the warning row. Default resolution is on the host (where the gray config is
   readable); when `model` is passed, allowed_models pre-validates it, 3006 as server backstop.
5. **No session-title freezing:** CronCreate's `setCustomSessionTitle` is not copied (idle creation
   mostly happens mid-way through a working session). (D50 later bound the task to the creating session
   but still does not freeze the title.)
6. **Static turn-tail card** (cron's ConversationTurnGroup pipeline, rendered after the reply
   completes): moon icon + task title + position snapshot at creation (`#N in queue`, from the take
   result) + 「去到闲时任务」 button -> `onOpenAutomationsMain(offPeakTaskId, "idle")` -> idle tab edit
   view. No live subscription, so history review has no stale live data.
7. **Entry surface only the tool:** Automations main-view button and New task home entry unchanged;
   `needsApproval: true` copied from cron (creation consumes take-number quota).
8. **Gating:** gray miss (D31) / remote workspace (D37-3/D48-B) / subagent_child do not expose the tool,
   delivered via the `offPeakToolEnabled` flag of session create/resume params (old host sends none ->
   tool not registered, fail-closed); a gray flip midway accepts "tool surface of this session
   unchanged + server take-number fail-closed backstop", no turn-level gray re-check. D30-8's
   "creation pre-creates no conversation, sessionId backfilled on first run" is unaffected - tool
   creation and form creation share `OffPeakTaskService.createTask`. **2026-09-04 addendum:** the gate
   is a workspace-level fact; the authoritative carrier is `workspace/updateOffPeakToolPolicy` called by
   the host when the agent client is ready (old CLI method-not-found degrades and is ignored), covering
   legacy create/resume, v4 createSession and v4 cold resume (subscribe's parameterless channel); the
   per-request flag stays as same-source redundancy. The card jump uses "forced refresh completed after
   navigation received" as the readiness signal (agent persistence bypasses the UI store); on refresh
   failure it makes no found/missing verdict and shows a list-load-failure hint (review CR-01).
   **Gray flip midway:** the handler returns the stable failure `offpeak_disabled` for gray off/config
   missing, without whitelist inference; model pre-validation is trimmed and case-insensitive (review
   SG-02/03).

Consequence: spec §5 "removed entries" drops "Create via chat into idle-time" (the composer moon switch
and the 429 toast guidance stay cut); §7 not-doing is synced. D30-4's remaining rulings hold.

### D49-8 revision: 3.12.2 chat startup no longer waits for the gray release (2026-09-14)

Supersedes the registration-phase gray judgment above: a supporting local Host decides tool
registration only from service assembly and workspace type, without reading remote config. The
workspace policy and the legacy/V4 create/resume flag stay as the local capability channel. When the
gray release is off/unknown, the model still sees OffPeakCreate/OffPeakList; only after an actual
OffPeakCreate call enters the Host handler are the gray release read and plan/model validated, with
createTask/take-number after that; a failure keeps the existing stable tool error and has no creation
side effect. OffPeakList queries only the current workspace's local tasks. Page-entry gray release,
remote unsupported, no sub-agent registration, idle-turn rejection of recursive creation, approval and
binding guards are unchanged. There is no async tool top-up for already open sessions and no background
config refresh. Original defect: registration and the create command both resolved the remote gray
release repeatedly, and failures were uncached so ordinary chat waited serially and repeatedly; the
locally handleable capability and "does the account allow creation" are two boundaries and the former
should not wait for the latter.

## D50 In-conversation idle task is bound to and runs in the creating session (decided 2026-09-07, revises D49-5's "no binding to the creating session")

User need: a task created in a conversation should execute "based on the existing session". Option B
(fork a child session at creation inheriting history) was rejected; chose A: **aligned with
CronCreate's targetTaskId** - bind the current session at creation, resume that session at dispatch and
send the task's original prompt. Six rulings:

1. **Always bound, no switch:** an in-conversation `OffPeakCreate` always binds the current session
   (`boundSessionId` filled by the CLI port from the tool context, passed via the `offPeak/create`
   protocol to the host, `repo.create` writes `session_id`; `conversation_id` still backfilled on first
   run, keeping "non-empty = has run"). Form creation is unchanged and still creates an independent
   session (D30-8 holds for the form).
2. **Default permission mode keeps D49-4's yolo and is not rolled back after the task ends:** unlike
   cron (which snapshots the session's current mode), idle switches the user's session to full access
   and keeps it; the user explicitly accepted this.
3. **No title freezing** (D49-5 kept): the bound session is the user's working session.
4. **Duplicate binding rejects only non-terminal:** when this session already has a queued/running/
   paused idle task, creating another is rejected (two unattended prompts would fight for one session);
   allowed after the task finishes (idle tasks are one-shot, unlike cron's permanent one-per-session).
5. **Probe before dispatch when busy:** a bound first run first reads tasks-index `status === "running"`;
   if busy it returns transient to the scheduler backoff (30s doubling, cap 15 minutes, no attempt
   limit) and **touches no session config**. Reason: CLI `session/send` rejects concurrent prompts with
   -32010, but `setMode` has no active-turn check, so writing config before hitting busy would silently
   change the user's session permission mode. A deleted bound session -> permanent (no backoff to
   ticket-expiry re-take).
6. **Stop = cancel:** pressing Stop while the task runs in the user's session stops the task turn;
   result tracking maps stopped to `cancelled` and the ticket is voided (no "back to queued for the next
   ticket"). User input during the task turn enters the v4 queue behind it.

UI follow-ups: Automations idle card footer and edit page show the **bound session title**
(`repo.list` joins the same-db tasks table into a read-only derived `sessionTitle`, not persisted), the
edit page carries the Stop = cancel hint; the chat turn-tail card status row adds "will run in this
session". Sidebar: the bound session joins the idle system group when `offPeakTaskId` is stamped on
first run (D48 mechanism, same as cron targetTaskId). D49-5's "task runs in its own new session, no
binding" holds only for form creation; tech-design §4.7's dispatch branch goes from two branches to
three (resume / bound-first-run / init).

### D50 addendum: 2026-09-08 machine-review responses

- **CR-01:** the `OffPeakCreate` description / modelInstructions still said "fresh session / NEW
  session / self-contained prompt", contradicting D50; changed to "later continues THIS conversation
  with the full history", allowing the prompt to refer to existing context but still requiring the
  deliverable to be stated (unattended runs cannot ask). A second review found the `prompt` parameter's
  `.describe()` in contracts (which enters the model-visible inputSchema via zodToJsonSchema)
  contradicting the tool description; fixed with a JSON-schema-level wording assertion.
- **CR-02:** the CLI port's binding guard (D50-4) read `offPeak/list`, which is display-truncated to
  top-20, so with more than 20 tasks and an older bound task the guard let it through; a second review
  noted the TOCTOU between the pre-check and INSERT around the take-number round trip. Final two layers:
  1) `OffPeakTaskService.createTask` calls `repo.hasActiveBoundTask(workspaceKey, sessionId)` as an
  exact pre-check before taking a number (not reusing the display list), hitting returns
  `client_validation / session_bound`; 2) a storage-level partial unique index
  `idx_off_peak_bound_active ON (workspace_key, session_id) WHERE session_id IS NOT NULL AND status NOT
  IN terminal` rejects the INSERT of a concurrent request that passed the pre-check, also mapped to
  `session_bound` (the ticket already taken is voided with the task and reclaimed by server expiry; no
  release endpoint). A stock database already holding duplicate rows fails to create the index and skips
  it, leaving only the pre-check until manual inspection. The host `offPeak/create` handler no longer
  carries its own pre-check; the CLI port's top-20 guard stays as a fast path and the CLI translates to
  stable wording.
- **SG-02:** `workspace/updateOffPeakToolPolicy` failures swallowed only -32601, others rejected client
  readiness; now all errors log warn and are not thrown (the failure direction is fail-closed: the CLI
  does not register the tool by default).
- **SG-03:** the default thinking level moved from `defaultLevel ?? levels[0]` to the highest by the
  known strength table (max > xhigh > high > medium > low > minimal > nothink > none), falling back to
  defaultLevel / first only when the catalog names are all unknown; the user ruled highest-level wins
  over the catalog defaultLevel.
- **SG-01 unchanged:** gray off does not push `enabled:false` to an already started CLI - the D49-8
  decision "tool surface of this session unchanged + server fail-closed backstop"; pushing only true
  was a deliberately narrowed direction after the pre-push regression.

## D51 Idle turns forbid Bash background execution (decided 2026-09-07)

Problem: after a background Bash command completes, `runTaskNotificationBatch` starts a notification
turn that carries no `turnExecutionModel`/`offPeakTaskId`; once the idle turn has ended or failed the
session model is back to the user provider, so a full agent loop ran on the user's own plan with no
user action (bypassing the D33 billing boundary).

**Do not repair the notification turn's attribution; close the Bash background surface in idle turns:**
`bashHandler` reads `context.offPeakTurn`; an explicit `run_in_background` throws a recoverable
`ToolExecutionFailed` (hint: rerun in the foreground), and the timeout-driven auto-background
(`isBashAutoBackgroundEligible`) is also disabled, so long commands follow the foreground timeout.
Symmetric with the subagent runner's existing `BACKGROUND_UNAVAILABLE` (idle turns reject background
Agent): both background entries fail closed in idle turns. Not done: notification turns carrying the
model / deferral (needs holding temporary credentials across turns, conflicting with D33 cleanup);
cron automation turns are unaffected (they use the user provider). **Superseded in scope by the
background lifecycle plan** (`background-lifecycle-plan.md`), which opens background Agent / Bash /
SendMessage in idle turns with whole-task closing.

## D52 Idle turns forbid SendMessage and Workflow (decided 2026-09-14, hotfix/3.12.2)

Problem (ZCT-2099408932463325184, 3.12.1): when the main Agent resumed a finished sub-Agent with
`SendMessage`, `resumeTerminalAgentInBackground -> runBackgroundAgent` in `subagent/runner.ts` passed
only a signal and not the idle turn's `subagentModelOverride`; with no override and no explicit profile
model, `runExploreAgent` fell back to `getSessionModelSelection()`, which per D33 is always the user
Provider, so the resumed turns were billed to the user's Coding Plan. (3.11.2 followed idle plan on the
same path because the runner read `turnExecutionModel`; a provider-refactor regression.) The `Workflow`
path has the same issue: script child sessions build models from the parent's resident selection, and
bypass D51's `modelOverride.background === "deny"` check (no modelOverride, no deny).

**Do not add an override to the resume path; disable the two tools in idle turns** (user ruling). Three
layers as D49: turn denylist (core `OFF_PEAK_MUTATION_TOOL_NAMES`, V4 `prompt-turn.ts`, legacy
`server-operations.ts` same value extended to `["OffPeakCreate","SendMessage","Workflow"]`) hides the
tools; the handler reuses `assertNotOffPeakTurn` to throw a recoverable `PermissionDenied` with a hint
to use a foreground Agent; the denylist fallback of `isOffPeakCreateRestrictedTurn` recognizes only the
OffPeakCreate sentinel (a denylist dispatched by an old host may not yet carry the new tools). Sub-Agents
inside an idle turn complete in the foreground, so SendMessage has no other valid use and disabling it
loses nothing. Not done: passing override through the resume path (conflicts with D51's background deny,
needs a foreground-wait design); title generation keeps using this turn's model (`session-title.ts`
still uses the resident selection, one small request per session, handled separately). **Superseded in
scope by the background lifecycle plan,** which lifts the D51/D52 background and SendMessage
restrictions under the whole-task lifecycle (`spec.md` "Background work and ticket closing").

## Discussion queue

(All converged; the final form is in `spec.md`.)
