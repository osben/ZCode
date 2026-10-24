# Automation edit status display

## Goal

When an automation opens in the edit page, the `Settings` tab shows the task's current status at the top of the form, so the user can confirm the task is still running before changing title, schedule, or instructions.

Monthly-interval and yearly month/day picker E2E use a local Personal Provider, with no account entitlement. These two cases must not seed a fake OAuth identity: a real control plane rejecting the fake token would cover the form with a login-expired dialog. Tests still click controls through a real WebDriver and never bypass dialogs or relax clickability assertions.

## Language sync of the create-page default title

When creating a new automation without a template draft, the task title uses the current UI language's localized default. If the user switches Chinese/English on the create page, an input still holding the auto default must switch to the target language immediately, instead of keeping the old language while the rest of the page switches.

- Only sync the default title auto-filled by the create page. Titles the user edited, titles from More ideas templates, and saved task titles are user data and must not be overwritten on language switch.
- Syncing the default title is not a user edit: no dirty flag, no unsaved-back confirmation, no reset of prompt, schedule, project, model, or reasoning effort.
- The behavior lives in `AutomationEditView` shared by desktop and regular Web; it does not touch the scheduler, task persistence, or the mobile `/remote` replayable path.

## Minute-interval anchor semantics

"Every N minutes" means counting from the moment the task is created or its schedule last changed — never firing early on standard cron wall-clock minute ticks. `*/N * * * *` is still saved as the compat display expression, but scheduling must also save `unit = minute`, `interval = N`, and `anchorAt`, and `scheduleRule` is authoritative for computing times.

```text
11:46 create "every 10 minutes"
  -> anchorAt = 11:46
  -> first run = 11:56
  -> next runs = 12:06, 12:16, ...

not:
11:46 create -> cron wall-clock tick 11:50
```

- On create, `anchorAt` is the time the service layer actually receives the create request.
- When the schedule is changed to "every N minutes", `anchorAt` resets to that change time; the first run is N minutes later.
- If the scheduler polls or dispatches late, later runs still advance from the same `anchorAt`; no cumulative drift from actual dispatch times.
- Other fixed-time daily, weekly, monthly, and yearly rules keep local calendar time and their wall-clock semantics.

## Custom monthly interval compat cron

"Every N months" is expressed by `scheduleRule = { unit: monthly, interval: N, ... }`, and `scheduleRule` is the authoritative fact for next-run computation. The five-field cron month field only accepts `1-12`, so an arbitrary N cannot be written as `*/N`; for example every 29 months as `*/29` fails cron validation in `AutomationService.create`.

```text
UI: every 29 months on day 1 / 15 / 16 at 09:00
      |
      +-- cronExpr ----------> 0 9 1,15,16 * *   (legal every-month candidate expression)
      |
      +-- scheduleRule ------> unit=monthly, interval=29, monthDays=[1,15,16]
                                      |
                                      v
                           authoritative next-run calculation
```

- The compat cron of a custom monthly rule always uses `month = *`, keeping only minute, hour, day-of-month, or the first weekday; the monthly interval is never encoded in cron.
- Create and update must still persist `scheduleRule`; the scheduler computes real trigger times from `scheduleRule`, never dispatching at the compat cron's monthly candidate frequency.
- Management cards and the edit-page summary display from `scheduleRule` first, falling back to parsing `cronExpr` only for old records lacking `scheduleRule`. "Every 30 months" must therefore never display as "monthly" because the compat cron has `month = *`.
- The rule supports the UI's full interval range without generating illegal cron for `N > 12`; desktop and regular Web share one builder, and mobile `/remote` adds no separate scheduling logic.
- `scheduleRule` is a domain fact: before create/update writes to the database, `AutomationService` must validate a positive integer `interval`, hour/minute ranges, and the unit's required date fields; monthly rules allow at most 1200 months. An invalid rule must be rejected whole — never rely on the computation function to silently round, default, or return `null`, which would persist an active task that never gets a `nextRunAt`. The legal 1200-month boundary must still compute a next run rather than being cut off by search limits.

## Schedule display for session-created tasks

The editor decides whether to take over the schedule rule by task origin, never by whether the cron happens to be parseable by the UI builder. A task with a non-empty `targetTaskId` is session-origin: even for a parseable minute interval like `*/10 * * * *`, the edit page shows only a read-only "Custom" row — no frequency controls, schedule icon, or next-run time, and it does not open the custom-repeat dialog.

```text
open existing automation
          |
          v
targetTaskId is non-empty? ---- no ----> UI schedule builder
          |
         yes
          v
read-only "Custom" schedule
          |
          +-- edit another field --> preserve cron + scheduleRule unchanged
          |
          +-- remove schedule -----> empty schedule
                                          |
                                          v
                                 UI schedule builder
```

- Session-origin detection uses only `targetTaskId`, not cron visualizability or `scheduleRule` content.
- While the read-only schedule is not removed, saving title, instructions, model, or other fields preserves the existing `cronExpr` and `scheduleRule` verbatim; merely opening and going back must stay clean.
- Only after the user removes the "Custom" row does the page switch to the standard UI schedule flow, where any UI-supported rule can be set.
- UI-origin tasks are unaffected; the same minute cron still round-trips through the existing builder.
- The rule affects only the desktop/regular Web edit form; it changes no scheduler, desktop continuous message flow, or mobile `/remote` replayable recovery boundary.

## Status source

The edit page shows a read-only status and never changes lifecycle in the form. Status resolution reuses the list-page semantics:

```text
automation.lifecycleStatus / enabled
        |
        v
+-----------------------------+
| failed / completed terminal |
+-----------------------------+
        | no
        v
+-----------------------------+
| paused or enabled = false   |
+-----------------------------+
        | no
        v
+-----------------------------+
| active                      |
+-----------------------------+
```

- `failed` and `completed` take precedence over `enabled` — they are terminal states.
- `paused` covers `lifecycleStatus = paused` or `enabled = false`.
- Everything else shows `active`.

## UI constraints

- The create/edit page shows a full title area between the breadcrumb and the Settings/History tabs: the edit-mode main title is fixed as “编辑定时任务” (Edit automation), create mode uses “新建定时任务” (New automation); the specific task name appears only in the breadcrumb, avoiding duplication. Main title style `text-ui-xl font-semibold`. Below it is a dynamic subtitle: create mode explains configuring run time, instructions, and run mode; edit mode explains adjusting the same; subtitles use `text-ui-base` and secondary text color. Fixed copy must be internationalized.
- The status row shows only for an existing automation; a new task has no persisted status and shows no row.
- Status dot and text use semantic tokens: active uses success, paused warning, failed destructive, completed subdued text.
- The status row uses a compact form-field layout that wraps on desktop and mobile Web narrow screens.
- Status copy goes through i18n; never hard-code English or Chinese.

## Unsaved-back confirmation

Before returning from edit to list, check the form for unsaved changes. The dialog protects only fields that would be saved, so merely opening the page or switching to the History tab must not trigger a false positive.

```text
User clicks breadcrumb back
        |
        v
+-------------------+
| form dirty?        |
+---------+---------+
          |
    no    | yes
    v     v
  back  Unsaved Changes dialog
          |
          +--> X / overlay / Esc: close dialog, stay on edit page
          |
          +--> Discard: abandon local form changes and back
          |
          +--> Save: submit same payload as header Save
                    |
                    v
              save success? ---- no ---> keep dialog/page for retry
                    |
                   yes
                    v
                  back
```

Dirty comparison scope:

- title, instructions, cron expression, end time.
- `scheduleRule` for non-session-created tasks.
- model, mode, thinking effort.
- Only fields the user actually touched join the dirty comparison. Post-init async normalization of model metadata, thinking effort, or the cron builder is system backfill and must not make open-then-back trigger the unsaved dialog.
- The first frame of an existing task must initialize the schedule form directly from the persisted cron, `scheduleRule`, and `endAt` — never render a default schedule first and backfill via effect. Callbacks from schedule-control mount/registration are not user edits; a session-created custom schedule must stay clean on open-then-back.
- Once the user returns a touched field to its initial value, that field is clean again.

```text
persisted automation ----> form initialization ----> runtime normalization
         |                                               |
         +-------------- initial baseline ---------------+
                                                         |
user interaction ----> touched fields -------------------+
                              |
                              v
                 compare touched fields only
                              |
                      equal / different
                       clean / dirty
```

## Top action visibility

Edit-page top actions collapse by current tab:

```text
AutomationEditView
        |
        +-- Settings tab: Run now + Save + More actions
        |
        +-- History tab: More actions only
```

The `History` tab only views run records and carries no form actions, so it hides `Run now` and `Save` — users must not think the history list gets saved or immediately executed.

## Run history navigation

"Jump to session" in run history is an explicit session deep link that must restore both the target workspace and the target session; closing the Automations main view alone is not enough. Automations is a cross-project list, and the history task's local workspace may not be in the current window tabs, so navigation must first ensure the local workspace tab exists, then set that workspace's active task.

```text
run history click(sessionId + workspacePath + workspaceIdentity?)
        |
        +-- existing matching tab --> activate tab
        |
        +-- missing local tab ------> add and activate local tab
        |
        +-- missing remote identity attachment --> reject, keep Automations visible
        |
        v
set target activeTaskId --> switch main view to chat
```

- Identity matching uses `workspaceKey = workspaceIdentity?.trim() || workspacePath`; never hit a remote tab by path alone.
- A local workspace without `workspaceIdentity` may open a tab by `workspacePath`; this is UI navigation recovery — it creates no new Agent runtime and changes no session's workspace.
- A remote workspace without an existing shared-host attachment in the current window must fail closed; no pseudo-remote tab from path or identity alone.
- Only after the navigation layer accepts the target workspace/session does the view switch from Automations back to chat; on failure stay on the current page.
- This affects only desktop/regular Web continuous UI navigation; mobile `/remote` exposes no Automations and its `web-remote-replayable` snapshot, queue, and reconnect boundaries are unchanged.

## Save and run now

On the edit page's `Settings` tab, `Run now` uses the current form as the only run configuration. A click must first submit the same payload as `Save`, and only after a successful save run the same `automationId` immediately; never run the stale automation snapshot from page entry by bypassing the form. A failed save or invalid form triggers no run, and the page stays in edit mode for fixes.

```text
Run now click
  -> validate current form
  -> save current title / prompt / model / mode / schedule
       | failure -> stay on edit page, do not run
       v success
  -> runAutomationNow(existing automationId)
  -> stay on edit page
```

Save-plus-run is single-flight: rapid repeated clicks must not double-submit the save or create multiple manual runs.

A manual run's execution identity must flow from dispatch to terminal state and never reuse the session-creation trace:

```text
manual runId
  -> sendPrompt.traceId / inputId
  -> services activePromptInputIds
  -> terminal outcome.inputId
  -> settle run outcome + release manual claim
  -> dispose terminal subscription / claim heartbeat
```

The unbound task's `createTask.traceId` only denotes session creation and takes no part in this execution claim. A dispatch failure must clean up the listener and heartbeat under the same `taskId + runId` subscription key; the terminal state accepts only events with `inputId === runId`, so an old execution round cannot settle the current manual claim.

## Run count semantics

The automation card's run count shows only the cumulative dispatched count — never `current / max`. `maxRuns` still drives finite-schedule lifecycle decisions but is not the card's denominator, avoiding the misreading of manual runs as quota consumption of a finite plan.

```text
scheduled trigger
  -> schedule run first dispatch accepted
  -> runCount + 1
  -> advance nextRunAt / maxRuns / lifecycle

run now
  -> manual run first dispatch accepted
  -> runCount + 1
  -> keep nextRunAt / maxRuns / lifecycle / manual claim
  -> release manual claim on real turn terminal state
```

- `runCount` counts the total first-accepted dispatches of both schedule and manual runs; failed dispatches and misfire skips do not count.
- Finite plans must use a separate schedule dispatch counter for `maxRuns`; never advance lifecycle from the display `runCount`. On historical database upgrade, initialize the schedule counter from the pre-upgrade `runCount`; manual runs after upgrade only update the cumulative display count.
- Duplicate or late success reports for the same manual `runId` must be idempotent and never increase `runCount` twice.
- A manual run affects only the cumulative display and `lastRunAt`: it consumes no finite `maxRuns` and advances no cron, enable state, or lifecycle; the manual single-flight claim still settles on the real turn terminal state.
- Cards on desktop and Web uniformly use the `automations.runCount` copy; both Chinese and English insert only the cumulative `count`.

## Dispatch config write-back

When an automation triggers, the task's currently saved model, Think, and mode must be written back to the bound session before the prompt is sent. The model updates the runtime and conversation projection atomically through V4 `switchModelConfig` first, then Think converges explicitly on the target model, and finally the permission mode converges through `switchCollaborationMode`. Never go through legacy `session/setModel` first: once the runtime has switched, the follow-up write can return noop and leave the session toolbar showing the old model.

```text
automation dispatch
  -> V4 switchModelConfig(model + think + runtimeModel)
  -> V4 state.updated.config
  -> V4 switchModelConfig(target think)
  -> V4 switchCollaborationMode(permission mode)
  -> send prompt
```

- This guarantees only that the current trigger uses the task's currently saved config; it does not migrate or repair historical task data.
- Desktop `desktop-continuous` keeps consuming the conversation projection; mobile keeps the `web-remote-replayable` command/snapshot recovery boundary.
- Manual model switching in normal sessions and the existing `setModel` compat path are unchanged.

When editing an automation and switching models, Think must re-converge on the target model's capability, never reuse the source model's saved value. Saving is blocked until the target model metadata finishes loading; a load failure must enter a non-submittable failed state with retry, not be interpreted as "Think unsupported". When Think is supported, save the validated target level; when unsupported, the update must explicitly send `thoughtLevel: null` to clear the old value. Omitting the field is forbidden: `undefined` in update means "do not modify", which would leave the old model's `max` level behind and trigger `Unsupported reasoning effort` at the next dispatch.

When the saved model is not in the current served candidates, the editor's model trigger keeps showing the historical model name; opening the menu shows only current candidates and never re-adds the historical model. This is display-only: candidate source, form validation, save, dispatch, and runtime model resolution semantics are unchanged.

The automation editor's Think capability display must use the same provider model metadata as the session composer. When the target model's metadata declares reasoning levels, that set is authoritative for display and save validation; the old workspace runtime catalog is only a compat fallback when metadata is missing. While the runtime preview is pending, has not projected `thought_level`, or returns a non-empty old level set that conflicts with metadata, keep using the metadata levels — a stale projection must not override the new model capability the composer already adopted. Only when both provider metadata and a successful preview have no levels may the Think control be hidden and the model be saved as a no-Think model.

```text
select target model
  -> provider model metadata (same source as conversation composer)
     -> Think options available -> render target levels immediately
     -> no Think option         -> keep control hidden while preview resolves
  -> load target runtime preview
     -> pending                 -> disable save
     -> options match metadata  -> validate/persist metadata thoughtLevel
     -> stale options conflict  -> retain metadata levels for composer parity
     -> no runtime option + metadata options
                                -> retain metadata levels for composer parity
     -> metadata unavailable    -> fall back to runtime thought levels
     -> no option from either   -> persist thoughtLevel: null
     -> failed                  -> disable save and expose retry
  -> next dispatch uses target model without stale Think
```

## CronCreate current-turn ownership boundary

An automation session must not recursively create automations. The current permission check uses only the `automationId` that Host admission explicitly passes in this turn; if a compat entry still carries an `automation-*` run id, that run id is the only current-turn automation fallback fact. `sendText` no longer queries task metadata and never guesses this turn's ownership from a session-history `cronAutomationId`. The old fail-closed policy of injecting a `CronCreate` denylist into a plain prompt when the ownership query fails is retired.

```text
Host admission
      |
      +-- automationId / automation run id present
      |       -> automation turn
      |       -> deny CronCreate + CronUpdate + CronDelete
      |
      +-- no current-turn automation fact
              -> explicit user turn
              -> do not query task metadata
              -> do not inherit historical cronAutomationId permissions

Cron mutation tool execution
      -> executor marks current automation turn
      -> CronCreate / CronUpdate / CronDelete handler: reject
      -> CronList handler: allow
      -> otherwise CronCreate additionally checks bound session
             -> automation/checkTaskBinding(targetTaskId)
                    -> workspace-scoped EXISTS query
                    -> bound: reject
                    -> unbound: automation/create
                    -> -32601 Method not found
                           -> compatibility fallback: automation/list
                           -> filter targetTaskId in current session
                           -> bound: reject
                           -> unbound: automation/create
                    -> other query failure: reject create only
```

- The three write tools have two independent guards: the provider request first hides `CronCreate` / `CronUpdate` / `CronDelete`; even if an old entry or abnormal provider bypasses the visibility filter, the tool executor still passes the current-turn automation fact to the handlers, and all three must reject before calling `AutomationPort`. `CronList` is a read-only query and stays callable in an automation turn.
- In a normal turn, `CronCreate` is additionally validated by `AutomationPort` through the dedicated `automation/checkTaskBinding` on whether the current session already has a bound task. The Host runs only a `target_task_id` existence query inside the current workspaceKey, never reading or serializing the full automation list — corrupted display fields of historical tasks (title, model, permission mode) can no longer break the new Host's ownership check.
- When a new CLI/bootstrap connects to an old Host, the old Host returns JSON-RPC `-32601 Method not found` for `automation/checkTaskBinding`. That error only means the capability is missing: fall back to `automation/list` and decide binding only by the current `targetTaskId`; if the fallback list query fails, treat as unknown and reject the create. Errors other than `-32601` (database, transport, timeout, protocol validation) stay fail-closed with no `automation/create`, so a real failure is never misread as "unbound". This is a different boundary from V4 `sendText` not querying task metadata; do not merge them into one "ownership query".
- When the automation repository reads historical `mode`, accept only currently supported permission enum values; blank or unknown values parse as unset, so one dirty record cannot fail the whole `automation/list` protocol batch. Create/update writes still reject illegal values through strict types and the protocol schema, so no new dirty data is produced.
- An empty `automationId` means this turn is a normal user session. Even if the bound task's metadata stores `cronAutomationId`, later user turns must not be permanently downgraded to read-only.
- Admission must carry the automation fact down with the current turn's command, not patch it in with an async metadata query; there is no intermediate state of "query failed, continue the prompt but hide CronCreate".
- Desktop `desktop-continuous` and mobile `web-remote-replayable` both reuse the current-turn admission fact; shared-host attachment, command queue, and snapshot recovery semantics are unchanged.

## Internal task-store execution boundary for Bash

`tasks-index.sqlite` is the Host domain service's internal storage, not a Bash API. The model must not read or write it directly through Bash; automation definition access goes through `CronList` / `CronUpdate` / `CronDelete` and `AutomationService`.

This version fully removes dedicated protection of the automation internal store on the generic Bash execution path: no OS sandbox or capability probe is added, no `bwrap` / Seatbelt wrapper, no protected-resource protocol field, and no command-string-based detection or rejection of database access. Shell variable, cwd, script, symlink, and cross-platform expansion semantics cannot be reliably reconstructed by keywords or regex; keeping heuristic checks would only create a false sense of an established security boundary.

```text
Bash request
    -> preserve the existing generic Bash execution path
    -> ExecutionPort

AutomationService / Repo ---------------------------> internal database allowed
```

- `AutomationService` is the supported API for task definition changes, but that implies no Bash permission isolation for the database file: this version does not promise to block Bash access to `tasks-index.sqlite`, and command-string checks must not be described as a file-access security boundary.
- `ExecutionSandboxPolicy` keeps only Bash's original generic sandbox config and carries no automation-specific resource info; `dangerouslyDisableSandbox` semantics must not be redefined by the automation feature.
- If a strong security boundary for `~/.zcode` is needed later, design an independent cross-platform execution isolation first — covering desktop, Web remote control, macOS, Windows, Linux, containers, and remote workspaces — then land it as a product-level capability, not injected into all Bash requests from the automation feature.

## Recursion constraint in the CronCreate prompt

The `CronCreate` tool description and prompt field description must require the model to write the business work to do at each trigger directly, never instructing the prompt to create or configure automations again or call `CronCreate`. This constraint is a model tool contract; do not guess natural-language intent in contracts or handlers with keywords or regex.

```text
CronCreate description
      |
      v
model writes direct final-work prompt
      |
      v
AutomationPort.create

scheduled / manual automation turn
      |
      v
tool denylist: CronCreate + CronUpdate + CronDelete
```

- The tool `description`, `modelInstructions`, and prompt field description share one semantic: second-order scheduling is forbidden.
- No Chinese/English keyword tables and no runtime rejection because the prompt mentions `CronCreate` or “定时任务” (scheduled task) — that would misfire on diagnostics, documentation, and summary tasks.
- The hard boundary that actually stops an automation execution turn from changing task definitions is the turn-scoped mutation tool denylist; the model-facing description is never a permission boundary.
- The constraint adds no desktop main, relay, or Host business state; desktop keeps `desktop-continuous`, mobile `/remote` keeps shared-host attachment and the `web-remote-replayable` recovery path.

## In-session CronUpdate

A normal user session may list the current workspace's task ids with `CronList`, then modify the same automation definition with `CronUpdate`. Updates must reuse the existing `AutomationService.update` and automation record; simulating an edit with `CronDelete + CronCreate` is forbidden.

```text
conversation CronUpdate
  -> strict patch schema (id + synced title + optional definition fields)
  -> AutomationPort.update
  -> automation/update protocol (workspace injected by Host)
  -> AutomationService.update
  -> same automationId / targetTaskId / run history
  -> after the turn, show the same automation result card (opens details by automationId)
```

- Updatable fields are only `title`, `cron`, `prompt`, `recurring`, `maxRuns`.
- Every in-session `CronUpdate` must submit a synced, non-empty `title`. The title must describe the task after the update: when the schedule changes, the natural-language time phrase must change too (when `每5分钟` becomes `每6分钟`, the title must not keep `每5分钟`); when the prompt's meaning changes, the title changes too. This is mechanically enforced at the Agent contract layer, not left to the model's discretion.
- `recurring: true` switches to an infinite loop, and the domain layer must then guarantee `maxRuns` is empty: if the caller omits `maxRuns`, `AutomationService.update` normalizes it to `null` and atomically clears any existing finite limit; explicitly submitting a numeric `maxRuns` is contradictory and must be rejected before the write.
- `maxRuns: null` may only be submitted together with `recurring: true`. Submitting `maxRuns: null` with `recurring: false` or without an explicit `recurring` must be rejected before the write — never fall a missing limit back to a one-shot task and misjudge it completed.
- Input must include `id` and the synced `title`; a patch without a title is rejected at the Agent contract layer.
- The task must belong to the current workspace; the Host checks ownership with `workspaceKey = workspaceIdentity?.trim() || workspacePath` and returns an error when not found.
- The update changes no `automationId`, `targetTaskId`, workspace, session, model/provider/mode/Think, `runCount`, or run history, and does not pause or resume.
- Cron, finite-run, and lifecycle recomputation stay in `AutomationService.update`; the Agent duplicates no domain logic.
- Switching only `recurring=true` clears the old `maxRuns`; without a submitted `cron` / `scheduleRule`, the existing `scheduleRule` (including authoritative intervals over 12 months) must be preserved, never degraded to the candidate calendar cron.
- `CronUpdate` is a workspace write and needs the same level of user approval and audit as `CronCreate`.
- After a successful `CronUpdate`, the turn-end result card is shared with `CronCreate`, showing the updated title and schedule summary and opening task details by the original `automationId`; no card on failure, cancellation, or while the turn is still running. Multiple Create/Update calls on the same task in one turn show only the last state; a later successful Delete removes the card.

```text
CronUpdate recurrence patch
          |
          +-- recurring=true + maxRuns omitted --> normalize maxRuns=null --> clear old limit
          |
          +-- recurring=true + maxRuns=null ----> clear old limit
          |
          +-- recurring=true + maxRuns=N -------> reject before repo.update
          |
          +-- maxRuns=null without true --------> reject before repo.update
```

- The card is already the authoritative UI summary of the update result; after a successful `CronUpdate` the model gives only a brief text confirmation and must not repeat title, time, content, or status in a `text` fenced code block or a pseudo-file card.
- An automation's own execution turn must not manage task definitions: that turn hides `CronCreate`, `CronUpdate`, and `CronDelete` and keeps only read-only `CronList`, preventing self-edit, self-delete, or recursive creation. The isolation scope is the `automationId` or automation run id carried by this turn; a persistently stored `cronAutomationId` in task metadata must not permanently downgrade the whole bound session to read-only.
- A new turn the user explicitly starts in the same bound session is a normal user turn: `CronUpdate` / `CronDelete` must be re-exposed and may modify the task through the domain service; `cronAutomationId` is only for attribution and display, never tool permission.
- The supported modification path for automation definitions is `CronList` / `CronUpdate` / `CronDelete` and `AutomationService`, which atomically recompute cron, `scheduleRule`, `nextRunAt`, retry, and lifecycle. Editing `~/.zcode/v2/tasks-index.sqlite` directly from Bash is unsupported, but this version makes no claim of mechanically preventing it via command-text matching in the Bash handler.

```text
same bound session
      |
      +-- scheduled/manual dispatch turn
      |     automationId/runId present
      |       -> hide CronCreate/CronUpdate/CronDelete
      |
      +-- later explicit user turn
            no automationId/runId
              -> expose CronUpdate/CronDelete
              -> update through AutomationService
              -> supported path does not write tasks-index.sqlite from Bash
```

- The tool adds only in-session write capability; desktop `desktop-continuous` and mobile `web-remote-replayable` message flow, snapshot, queue, and owner semantics are unchanged.

## One-shot calendar task missing the target minute

Five-field cron has no year. When a one-shot task uses a fixed `minute hour day-of-month month *` expression and creation crosses the target minute, cron's next occurrence naturally rolls to next year. That case must not be displayed or scheduled as a yearly recurring task.

When creating a relative-time task in-session (for example "in 5 minutes"), the model must write the relative minutes into `CronCreate.delayMinutes`, never guess the current time or convert to absolute cron itself. The Host's `AutomationService` anchors on `Date.now()` at request receipt and generates a one-shot minute-interval `scheduleRule`, so `nextRunAt` equals receipt time plus the relative minutes; a fixed calendar cron is also generated as the compat display field, but `scheduleRule` drives scheduling. Absolute calendar plans pass `delayMinutes=null` and use `cron`.

```text
“3 分钟后提醒” (remind me in 3 minutes)
        |
        v
CronCreate { delayMinutes: 3 }
        |
        v
protocol relativeDelayMinutes=3
        |
        v
AutomationService: Date.now + 3min -> one-shot minute scheduleRule
        |
        v
persist cronExpr / nextRunAt
```

```text
recurring=false calendar cron
              |
              v
      compute previous / next
              |
              +-------------------+------------------------+----------------+
              | age < 60 seconds  | age 60s..5min         | otherwise
              | next rolled year  | next rolled year      |
              v                   v                        v
          due immediately     reject before write      keep next run
              |                   |
              v                   v
         dispatch once        retry with delayMinutes
         -> completed         or a confirmed future cron
```

- Applies only to finite-run tasks; `recurring=true` yearly plans keep their semantics.
- The sub-60-second window covers only a permission confirmation or tool call that crosses the minute boundary; beyond it, an erroneous past time must not run as an immediate task.
- Inside the original 5-minute miss window, the service layer rejects the stale target without writing; relative requests should use `delayMinutes`. Outside the window, a year-less cron cannot distinguish a "stale time" from "the user explicitly meant next year", so normal croner future-time semantics apply.
- Normal future one-shot tasks, `scheduleRule`, and recurring tasks are unaffected by this guard.
- Dispatch, run locks, and result write-back stay on the scheduler/host path; no second timer.
