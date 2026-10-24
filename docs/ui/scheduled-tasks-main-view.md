# Scheduled Tasks Main View Entry

# Goal

Scheduled task management moved from a Settings section to a workspace main-view entry. Clicking
"Automations" on the left keeps the workspace queue / task list on the left and switches the right-hand
main content to the scheduled task management page.

# Product Semantics

- Scheduled tasks belong to the current workspace's workflow management, not to global settings.
- Opening scheduled tasks creates no Settings tab, does not change the left queue list, and does not
  unmount the workspace sidebar.
- Selecting a task or creating a new task returns the main content to chat or the matching workspace
  main view.
- The page reuses the existing `AutomationsSection` and loads the automations of the workspace keyed by
  `workspaceIdentity?.trim() || workspacePath`.

## Run Now Semantics

- "Run now" is an independent manual run. It does not set the cron `next_run_at` to the current time and
  must not change the original schedule's `next_run_at`, `run_count`, enabled state or lifecycle.
- A prompt produced by an actual scheduled trigger or by "Run now" must show, above the user message
  bubble, the same clock icon and "Sent by scheduled task" source text as the left task list. The
  message-level source comes from the automation runId in the persisted `userInput.sourceCommandId`:
  both `automationId:scheduledAt` (`trigger=schedule`) and `automationId:manual:uuid`
  (`trigger=manual`) are shown; ordinary manual input inside the same cron session is not. The marker
  is derived from the row itself, so desktop continuous and mobile Web replayable recovery agree; it
  never reads the sticky `cronAutomationId` on the task.
- The current desktop host must resume or create the target session and submit the prompt directly
  inside the `runAutomationNow` RPC. The normal path does not go through scheduler polling, wake or a
  second claim. RPC success only means the host accepted the prompt; it may still sit in the runtime
  queue.
- Before claiming, `runAutomationNow` must confirm that the current service has a manual dispatcher
  injected. If it is missing the call fails directly: no `automation_runs` ledger row and no `running`
  claim. Only after that check is the manual run written to the ledger. If the host crashes during
  dispatch after the claim, the scheduler may reclaim the ledger row only after the claim timeout, as
  fault recovery, and must not affect the original cron cadence.
- The automation `running` single-flight lock of a manual run covers queue wait and the actual turn: it
  stays held after `sendPrompt` admission until the `turn.completed` / `turn.failed` terminal state of
  the matching `runId/inputId`. A second Run Now on the same automation while the lock is held is
  rejected and must not append a second queued prompt to the same task.
- The scheduler is used only for fault recovery of stale manual runs. When a recovery dispatch receives
  host `cron-dispatch-result ok`, it only writes `automation_runs.dispatch_status = dispatched` and must
  not release the manual claim; the terminal outcome subscription and heartbeat already established by
  the host own the rest of the lifecycle and release the claim at the real turn terminal state. Only a
  failed dispatch result makes the scheduler release the claim immediately.
- The `runAutomationNow` management RPC must explicitly return `queued` or `duplicate`. Only `queued`
  (a manual run was created and dispatched by this call) shows the "triggered" success notice. A
  single-flight-rejected `duplicate` shows an informational "previous run still in progress" notice,
  does not refresh the list and must not show the success notice. An empty RPC success must never be
  interpreted as both states. The UI uses a transient in-flight state only while this RPC is pending to
  prevent synchronous re-entry; once it returns the "Run now" entry is restored immediately, it is not
  disabled based on run history and the entry state is not polled. Repeated triggers on an active run
  are left to host single-flight, which returns `duplicate`.
- Failures of terminal-outcome write-back or claim release are logged as separate errors and must not
  overwrite the original dispatch / turn result. While the host is alive and the run is still
  queued / running, it must renew `claimed_at` periodically so long tasks are not released as stale;
  after a host crash renewal stops and stale-claim recovery takes over.
- A task created inside a session whose target session is not active must first resume that session
  before direct dispatch, then apply the task's saved permission, model and thinking effort.
- For a task created in the UI without a bound session, the empty session created at execution time
  must use deferred persistence. First `sendText` admission persists the session main record first,
  then writes the foreign-keyed `session_input`; timeouts must not be used to order creation and first
  submit.
- When automation dispatch creates or resumes an execution task carrying `automationId`, the session
  `toolDenylist: ["CronCreate", "CronUpdate", "CronDelete"]` hides the automation write tools at the
  runtime tool-registration boundary and leaves only read-only CronList. Do not write the runId into
  task meta: runId belongs to the `automation_runs` ledger, and writing it into task meta pollutes the
  UI run-now and bound-session recovery paths.
- For an already active bound session, `session/resume` does not rebuild the runtime, so the host must
  also pass `automationId` with this turn's `sendText/sessionSend`. The CLI temporarily removes
  `CronCreate/CronUpdate/CronDelete` from this turn's provider request so the model cannot recursively
  create, self-modify or self-delete; `activeAutomationId` and the `automation-port` CronCreate
  rejection stay as the backstop against forged create calls and must not call `automation/create`
  when hit. After the turn the original tool surface is restored; ordinary user input is unaffected.
- During Highspeed, users may still call `CronCreate`; the created record stores the session's stable
  `modelSelection`, not the current turn's temporary selection pointing at the Highspeed card's
  built-in Provider. Later scheduled runs use `automationId` as the final gate, use the provider/model
  stored in the record, and ignore a mistakenly passed Highspeed `modelSelection` / `modelExecution`,
  so a Highspeed card is never drawn, reused or installed.
- If the target session is active/routing busy, the turn-scoped `toolDisallowlist` must travel with the
  automation input into the deferred queue item and be passed unchanged to `startPromptTurn` after
  replay, reordering and drain; it must not be applied only on the immediate-start or `steerTurn`
  fallback paths.
- Ordinary user input on a task already owned by a scheduled task (`cronAutomationId` written into task
  meta) must also carry the turn-scoped automation write-tool hiding rule with `sendText/sessionSend`,
  so the next model step cannot bypass the ownership boundary and create, self-modify or self-delete.

```text
runAutomationNow RPC
  -> INSERT manual automation_run (does not touch automation.next_run_at)
  -> desktop host resume/create task (new session uses deferred persistence, automation execution task hides write tools)
  -> apply mode/model/thought
  -> sendPrompt (this turn carries automationId; may be queued)
  -> ACK: write back dispatched, keep holding the running claim
  -> queue drain / turn start
  -> turn terminal: write back outcome, release the manual claim by workspaceKey

scheduler stale recovery
  -> host sendPrompt ACK / cron-dispatch-result ok
  -> scheduler only writes back dispatched, does not release the claim
  -> host heartbeat + terminal subscription
  -> turn terminal: host releases the manual claim

busy session
  -> enqueueDeferredInput(toolDisallowlist=[CronCreate,CronUpdate,CronDelete])
  -> queue replay / drain
  -> startPromptTurn(toolDisallowlist=[CronCreate,CronUpdate,CronDelete])
  -> provider automation tools keep only CronList

Second Run Now (first run not terminal)
  -> repo.runNow sees running=1
  -> RPC returns duplicate / no-op, no second manual run
  -> shows the "previous run still in progress" info notice, not the "triggered" success notice
```

# UI Boundaries

- The top-level feature name is `Automations` (zh-CN "自动化"). "Scheduled tasks" (zh-CN "定时任务")
  names only the Scheduled tasks subtype and must not be used for the sidebar entry or main-view title;
  this keeps the "All / Scheduled tasks / Idle-time tasks" filters distinct from their parent container.
- Main view and edit pages share Settings' framework content tokens: `max-w-4xl`, responsive horizontal
  padding, `pt-0` and uniform bottom spacing. The Automations list, scheduled task edit, idle-time task
  edit and every Settings feature keep the same content column width, left start and top baseline. The
  outer workspace shell keeps the desktop drag region, stable scroll gutter and the existing `max-w-5xl`
  responsive route frame; Settings alignment is owned by the inner shared content tokens, and
  Automations sub-pages must not define their own content width and padding.
- The empty home page takes Figma `⚫️ Z.ai - Zcode` node `4798:2443` as the visual source of truth.
  The visible desktop content column is 802px wide; after the title description come, in order: a 226px
  empty-state card, a 44px keep-awake hint bar, the idle-time templates and the scheduled templates.
  Card to hint bar spacing is 16px, main sections are 32px apart, and the hint bar must not move above
  the empty-state card.
- The empty-state card has a 16px radius and a weak border, with copy and actions vertically centered
  as a whole. The scheduled `Create via chat` split button and the idle-time create button use the
  primary button level (white on black in Zai Dark, inverted by primary-button semantics in Zai Light);
  clicking the left part goes straight to session creation, the arrow only opens the creation-method
  menu. The scheduled primary button text uses full-opacity `text-primary-foreground` in default, hover
  and menu-open states and must not weaken default readability through reduced opacity; outline create
  buttons keep their existing default de-emphasis.
- Idle-time and scheduled templates both show the current Client Scenes catalog in two columns. Both
  card types use a three-part vertical structure: title row / flexible description / bottom time info;
  the scheduled template's cycle time sits below the description, never appended to the title row. Cards
  use `114px` min height, 12px radius, 12px padding and 16px grid gap. In the desktop two-column
  layout, cards in the same row stretch to the tallest card of that row so two-line and three-line
  descriptions align at the bottom, without a hard-coded global max height; on mobile the layout falls
  to one column and text wraps without overflowing the card.
- While the Client Scenes catalog loads, each currently visible idle / scheduled template section keeps
  its heading and shows 4 template-card skeletons by default (desktop: two rows of two; mobile: four
  rows). Skeletons reuse the template card's `114px` min height, radius, border and grid gap, and do
  not replace existing tasks or the manual create entry with a page-wide spinner. After success,
  business failure or network failure the skeleton ends and the real catalog or the existing failure
  fallback renders.
- Figma pixel values map to `DESIGN.md` semantic colors, `text-ui-*` font sizes and existing
  button/menu base components; do not introduce raw hex, `text-[…]` or transparent-white styles that
  only work in Zai Dark.
- The Automations main view, scheduled task create/edit, run history and related menus use the UI font
  size tokens: existing `text-ui-xs` becomes `text-ui-sm`; legacy `text-base` / `text-sm` / `text-xs`
  become `text-ui-lg` / `text-ui-base` / `text-ui-sm`; `16px` / `14px` / `13px` / `12px` become
  `text-ui-lg` / `text-ui-base` / `text-ui-base` / `text-ui-sm`; `text-ui-xs` only below `10px`. Do not
  add arbitrary UI font sizes.
- On the Automations home, besides the title, the instruction text, schedule info, run count and
  "earliest available slot" of created-task cards, idle templates and scheduled templates also use
  `text-ui-base`. The "Go to scheduled tasks" button on the in-session creation success card also uses
  `text-ui-base`, highlighted as plain `text-foreground` text with no trailing arrow or icon; its text
  hit area uses `6px` vertical and `12px` horizontal padding. The disabled state is expressed by overall
  opacity. These texts must not drop to `text-ui-sm` / `text-ui-xs` for being secondary; hierarchy is
  expressed through font weight and semantic color.
- The project, permission and model triggers in the scheduled task instruction toolbar use
  `text-ui-base`, matching the session composer's main controls.
- When the instruction toolbar selects a high-privilege mode such as full access, the permission icon
  and text keep `text-warning` like the session composer, with no flash back to the normal foreground on
  hover / menu-open; other permission modes keep the default text color.
- The status pill on the scheduled task settings page is fixed at `32px` height; the status dot is
  `6 × 6px`, centered in a `20 × 20px` icon frame. Text, status semantic color and horizontal padding
  are unchanged.
- On a paused scheduled task card, execution time and run count are de-emphasized with `opacity-40` to
  show they no longer advance; the paused status label and the resume action stay fully readable.
- Scheduled task cards do not show the internal retry queue state or the absolute/relative `nextRunAt`.
  Failed and completed tasks show a visual cron summary next to the status, or "Custom" when it cannot
  be safely visualized; retry counts and backoff stay in run history and logs.
- Completed task cards keep a fixed de-emphasized opacity; hover must not restore opacity or switch the
  card background; keyboard focus and opening details are unchanged.
- When the more menu of a completed idle-time task contains only "Delete", the divider above it is not
  shown; dividers only separate preceding task actions from destructive actions, never a semantic-less
  top line in a single-item menu.
- The card cron summary may append `· next run time`: `nextRunAt` must be strictly later than now; within
  30 days it is shown as relative time, beyond 30 days as absolute time; an expired or missing time
  renders neither the separator dot nor the time text.
- After a UI-created scheduled task enters the edit page it keeps the original editable schedule
  controls. A task created inside a session that cannot be echoed by UI rules shows a read-only
  "Custom" row with no icon and no `nextRunAt`, plus a delete button; after deletion the UI "Add
  schedule" flow starts, and saving a new UI cron / scheduleRule replaces the old session schedule.
- "Custom repeat" of a UI-created task supports minutes, hours, days, weeks, months and years. The
  repeat frequency is a directly editable integer input, not a dropdown; the control range is `0–200`
  but only positive integers `1–200` can be confirmed, so `0` (no execution semantics) is never saved
  as cron / scheduleRule. The input disables the native browser spinner and uses vertically stacked
  up/down step buttons on the right with the input control's border and hover semantic colors, for
  consistent visuals and click feedback on desktop and mobile Web. Desktop and mobile Web share the
  same control, range and confirmation validation. The real interval of every custom repeat is
  `scheduleRule`; cron only serves compatibility display and legacy-path candidates. Minutes above
  `59`, hours above `24`, days above `31` and months above `12` must degrade to a valid every-minute,
  every-hour, daily and monthly compatibility cron respectively; the narrower cron field range must
  never reduce the `1–200` product semantics.
- The first frequency selector of the editable schedule bar uses a full-opacity `#363636` background in
  every selected state (hourly / daily / weekdays / weekly / monthly / custom), consistent with the
  same-level time and minute selectors; it must not mix with the input background through opacity or
  theme-light colors, nor fall back to a transparent background for any frequency value or branch. All
  tags in the schedule bar share a `20px` text line height, `1px` vertical padding (`22px` total) and
  `8px` radius; the frequency Select keeps no transparent border or padding-box background clipping
  that shrinks the visible background. Hover and open states use `#404040`.
- Connector words between tags in the schedule sentence (e.g. "on", "th", "minute") use the same
  `text-foreground`, `text-ui-base` and `20px` line height as tag text and must not drop to secondary
  text color; the weekday multi-select tags after "Weekly" also use `text-foreground`, with no raw
  highlight color for selected days: selection is expressed only by dropdown checks and menu
  background. Weekday dropdown items use a menu layout with text on the left and a `16px` status slot at
  the end; the check is at the row end and unselected items keep an equal-width empty slot to avoid
  layout shift. Time zone and the full schedule summary stay `text-foreground-subtle` to keep the
  information hierarchy.
- Items of the frequency menu opened by "Add schedule" use `bg-menu-hover` and the primary foreground
  on mouse hover and keyboard highlight, with clear feedback in Light and Dark; raw transparent colors
  such as `bg-white/5`, visible only on dark backgrounds, must not override shared menu semantics.
- Hour and minute options in the time picker follow menu interaction semantics: hover and selected
  states both use `bg-menu-hover` and `text-foreground`, matching the frequency dropdown's hover /
  selected items in Light and Dark; the selected time must not render as a black `bg-primary
  text-primary-foreground` primary button.
- Operable popovers (time, frequency, permission, model) must sit above auxiliary tooltips when open;
  tooltips must not cover options or block pointer operations. This is ensured by the layering of the
  shared Popover, Select, Dropdown Menu and Context Menu, not by local z-index in Automations pages.
- The creation-method and task-action Dropdowns show the standard `shadow-md` continuously from the
  first frame; when the menu root receives keyboard focus the global focus reset must not clear the
  shadow, and hovering an item only changes the item background, never the trigger for the shadow.
- The scheduled task schedule input is fixed at `36px` height in every state ("Add schedule", ordinary
  schedule, custom tag, read-only schedule) and uses the global Input outline semantics like Task title:
  `border-input-border`, hover `border-input-border-hover`, focus `border-input-border-focused`. The
  idle-time page's `Soonest available` read-only input, Task title and the Instructions composite input
  reuse the same outline semantics and keep no transparent border. In the editable state the first tag
  is `8px` from the input's left edge; with `1px` vertical padding the tag is `22px` high, vertically
  centered in the `36px` input. The 1px outline is corrected by inner padding and must not change the
  total input height. Inner controls stay on one line, the schedule summary is the only shrinkable area
  and truncates when space is short; `min-height`, `flex-wrap` or `basis-full` must not let new tags
  grow the input.
- After a custom schedule is confirmed, the frequency, repeat period and time tags use `text-foreground`
  (text/primary) for inner text and `rounded-lg` (8px) radius; the repeat period must not hard-code raw
  colors such as `#F8F8F8`, and the controls on both sides must not fall back to a smaller radius, so the
  three tags share color and shape. The trailing chevron may keep a weakened foreground color.
- Main list cards and the in-session `CronCreate` success card show only schedule summaries that the
  current UI can stably visualize. A fixed month-day cron is ambiguous between a one-time date and
  yearly repeat, and an unrecognizable or abnormal cron cannot be safely interpreted; both show the
  localized "Custom" and must not be guessed as "Yearly" or expose the raw expression.
- Scheduled task list, create/edit, run history, menus, Toasts and template copy go through
  `useZCodeIntl` and switch immediately with the system simplified Chinese / English setting. Saved
  task title / prompt are user data and are not translated on language change; only localized defaults
  not yet modified by the user follow the locale.
- Choosing "Custom" in the schedule menu immediately opens a standalone `CustomRepeatDialog`; after
  confirmation the schedule bar shows only a compact frequency summary that can be clicked to edit
  again. On first open, cancel or close must not commit a custom schedule; when editing a confirmed
  schedule, cancel keeps the original value.
- The custom-repeat interval dropdown shows at most 8 options at once; more scroll inside the panel. The
  dialog follows Figma node `4727:3803`: 400px wide, 12px radius, 20px content padding and vertical
  spacing, 36px controls and action buttons.
- After custom repeat is confirmed the schedule bar uses three columns: frequency summary left, time
  picker strictly centered, delete action right; the time control position must not depend on the
  content width of the two sides.
- The hourly-repeat summary shows only the interval and minute offset, e.g. "Every 2 hours at minute
  00"; it must not append the builder's default hour value that other frequencies use (e.g. `09:00`).
- Required-field warnings on the scheduled task edit page appear only after the user explicitly clicks
  "Save" or "Run now". Normal editing actions such as clearing the title or instructions or deleting a
  schedule only update the draft and unsaved state and must not immediately show a destructive outline;
  deleting a schedule must also clear that schedule's existing warning. When only required content is
  missing, "Save" and the runnable-state "Run now" stay clickable to trigger validation; operational
  disables (saving in progress, model config not ready, project unavailable, task already has an active
  run) still apply.
- After a new or edited scheduled task has unsaved changes, going back must confirm discard; with no
  changes it returns directly. List-card delete, edit-page delete, and the unsaved-back dialogs of
  scheduled and idle-time tasks all reuse the Automation confirmation presentation, differing only in
  button text, color and action semantics. The presentation takes Figma `⚫️ Z.ai - Zcode` node
  `4582:1605` as visual source of truth: desktop width fixed at `448px`, min height `180px`, narrowing
  to `calc(100vw - 32px)` on small screens, `20px` padding, `rounded-2xl`, `20px` content gap,
  `bg-popover/98` and a borderless shadow level. The title uses `text-ui-lg font-semibold`, the body
  `text-ui-base leading-6`; the body shows at most 3 lines, and an overlong task title or unbroken text
  must wrap and ellipsize on line 3 without growing the dialog. Bottom `36px` buttons are right-aligned
  with `20px` distance from the right and bottom of the dialog; extra space from the min height stays
  between body and actions and must not become extra bottom padding through Grid row stretching. The
  unsaved-back actions are fixed as "Cancel / Discard", Discard is a destructive primary button, and no
  save entry is offered; destructive button text uses `text-destructive-foreground`, which resolves to
  white in Zai Dark. Automation confirmation buttons show text only, no glyph and no `esc` / `⏎`
  keyboard hints; this does not change other shared confirmation dialogs. The instruction input shows at
  most 4 lines and scrolls internally beyond that, with the bottom settings toolbar fixed.
- The back entry of scheduled and idle-time task settings pages shares a text-style interaction: default
  `text-foreground-subtle`; on hover, keyboard focus and press only the icon and text rise to
  `text-foreground`; the hit area may keep padding but no hover / focus background fill.
- Between field titles and the input, schedule or composite component below them on scheduled and
  idle-time task settings pages the vertical gap is `6px`. Field containers use vertical flex + gap, not
  `space-y` margins on inline labels, so font line boxes do not shrink the visible gap.
- The unattended-run note below the idle-time instruction area is neutral information, not an orange
  warning. The note row has an extra `4px` top spacing beyond the default field gap to separate it from
  the Instructions composite input; its leading icon is a 16px circular info icon in a 20px icon slot;
  icon and text use `text-foreground-subtle`, text uses `text-ui-base`.
- The permission suggestion shown when an idle-time task is submitted with non-full-access permission is
  a neutral, non-blocking hint and must not use an orange warning triangle. The Toast uses the Lucide
  `Info` circle icon with `text-foreground-subtle`, standard foreground body text, centered at the top
  of the page; this changes only the message semantics of the permission suggestion and must not weaken
  real warning Toasts.
- The Coding Plan upgrade hint and the scheduled-task manual-run hint of scheduled and idle-time tasks
  are also centered at the top of the page; action buttons, dismissibility and auto-dismiss time keep
  their own business configuration.
- All Toasts triggered inside the Automations main view prefer the Automations `main` region, not the
  whole window, as the horizontal centering reference. The Toast still portals to `body` so the main
  view's scroll container cannot clip it; the anchor bounds are re-read after region width changes,
  window resize or layout scroll. If the anchor is missing or unmounts during display, fall back
  immediately to full-window top centering; the Toast must still mount and start its auto-dismiss timer,
  so region-positioning never makes a message invisible or resident in memory. Top offset, stacking and
  animation keep the global Toast contract.

```text
Window
┌────Sidebar────┬──────── Automations main ────────┐
│               │              Toast               │
│               │                │                 │
│               │        main horizontal center    │
└───────────────┴──────────────────────────────────┘

main resize / layout scroll
            │
            ▼
getBoundingClientRect()
            │
            ▼
body portal updates fixed left
```

- New scheduled tasks and new idle-time tasks may both switch to the run-history tab to see the empty
  state; the history entry is not disabled because the task is unsaved. After entering history in the
  new state the create button is hidden, and no history request is made because there is no task
  identifier yet; switching back to settings restores the create action. The "Create scheduled task /
  Create idle-time task" submit buttons on the settings pages are plain text buttons with no Play or
  other icon before the label.
- Scheduled task run history directly shows the loading state, error state, empty state or history
  table, and does not repeat the "runs only while the computer is awake" hint at the top of the content;
  the keep-awake rule is explained only at the settings entry and next to its control.
- Scheduled and idle-time tasks without run history reuse one empty-state container, with Figma
  `4617:1176` and `4866:3110` as source of truth: min height `226px`, page background, default card
  border and standard card radius, prompt text centered horizontally and vertically in
  `text-ui-base text-foreground-subtle`. Scheduled tasks must not fall back to transparent plain-text
  whitespace.
- The "Scheduled tasks / Idle-time tasks" tabs of the Automations home follow the plugin market's
  public/personal tabs: standalone `rounded-full` pills, `px-3 py-1`, `text-ui-base font-medium`;
  selected `bg-selected text-foreground`, unselected secondary text with `bg-hover` on hover. The
  "Settings / History" tabs shared by scheduled and idle-time detail pages follow the Hooks scope tabs:
  container fixed `h-8 rounded-full bg-surface p-0.5`, options fixed `h-7 rounded-full px-2.5`, selected
  `bg-background text-foreground`, unselected transparent. Chinese labels are "设置 / 历史", English
  `Settings / History`.
- The Instructions composite input of scheduled and idle-time tasks reuses one structural component;
  sizes must not be maintained separately. The parent container has no border and uses `bg-surface`; the
  textarea itself uses `rounded-xl border border-input-border bg-input` and carries the hover, focus
  and invalid outline states. The body is `116px` high by default and as minimum with `12px` padding;
  the bottom toolbar is fixed `40px` high with `6px` padding (`h-10 p-1.5`). Manual resize is disabled
  on desktop and mobile Web; content still grows automatically to about 7 lines and then scrolls inside
  the body; on narrow screens the toolbar may wrap and grow with its content.
- The Instructions bottom toolbar of both task types uses the same control visuals and trigger states:
  project, permission, model and reasoning controls are `h-7`, `rounded-full`,
  `text-ui-base font-normal`, with `gap-0` between menu items (icon and text keep an inner `4px` gap).
  Default has no background; hover and menu-open use `bg-hover` and rise to primary text color. The
  permission trigger, like project and model, sizes to its content; no fixed min width or `flex-1`
  pushing the arrow away from the text. Dropdown arrows use Lucide `ChevronDown` with its native
  `24 × 24` viewBox and `2px` stroke, rendered at 14px in the toolbar: project and permission use a
  20px action slot, model and reasoning an 18px action slot; no fixed 20px wrapper nested inside the
  slot, so compact items are not clipped or visually small. After permission selects "Full access" /
  `yolo`, the leading icon, text and trailing arrow all use `text-warning`, including hover and
  expanded states. Menus expand above the toolbar with a `4px` gap to the trigger. The shared Workspace
  menu wrapper of Draft New must use `contents` so only the inner trigger is the visual and layout box,
  avoiding double-layer controls; the ordinary session project chip is unchanged.
- The model and Think selection of scheduled tasks directly reuse the session composer's responsive
  trigger composition; Automations must not maintain a variant with always-visible text or hidden
  icons: the model trigger shows the `Package` icon at compact widths and the model identity text with
  chevron from the composer `sm` width; that text reuses the session-side `resolveV4ModelTriggerLabel`
  rule (ordinary custom providers show `providerName/modelName`; Z.ai / BigModel built-in families,
  invalid-value fallback and narrow-screen cropping follow the session side), and Automations must not
  cut the provider to show only the last-level model name. The Think trigger always shows the `Brain`
  icon and shows the level text with chevron from the composer `xl` width. The Automations Instructions
  frame must establish a same-named `@container/composer` query context so desktop, ordinary Web and
  mobile Web switch by the control's own available width; the model menu, Think level ordering, i18n
  copy, selected state and single-level read-only model state stay owned by the shared session
  components. Automations may keep only three page-level differences: menus expand upward, chat input
  focus is not restored, and controls are disabled while model metadata previews.
- "Add schedule" uses Lucide `Plus` with its native `24 × 24` viewBox and `2px` stroke, rendered at 16px
  in a 20px icon container; the icon color inherits the current text semantic color.
- The more, run now, pause/resume, edit and delete entries of the scheduled task card menu use Lucide
  icons with the native `24 × 24` viewBox and `2px` stroke, rendered at 16px. Template cards use 12px
  padding, 12px content and grid gap, two columns on desktop and one on mobile; description and
  execution time use the theme semantic color `text-foreground-subtle`. The scheduled template title
  icon prefers the trusted HTTPS `img` of the Client Scenes prompt item, shown whole and proportionally
  at `16px`; if `img` is missing, untrusted or fails to load, it falls back to Lucide `Target` /
  `Activity` / `FileText` / `List` at `16px` with `2px` stroke in a 20px action slot, inheriting the
  current text color.
- Common Automations icons are maintained in `AutomationIcons.tsx` and re-exported by
  `AutomationDesignPrimitives`; pages must not redefine geometry or load cropped Figma SVG / mask
  assets. Apart from the explicit compact size of dropdown arrows, icons use the Lucide native
  `24 × 24` viewBox, 16px render size and `2px` stroke, with color inheriting `currentColor` so Light /
  Dark / Zai themes agree.
- The common icon mapping is fixed: hint `Info`, idle `Moon`, scheduled status `Clock`, paused status
  and pause action `CircleStop`, run now `Play`, continue/resume `CirclePlay`, edit `Pencil`, more
  `Ellipsis`, jump to session `ExternalLink`, refresh `RefreshCw`, delete `Trash2`; cancelling a run
  uses a filled `currentColor` `Square`. Pages must not override these mappings with similar icons.
- When the sidebar "Automations" button switches the workspace main view, Automations is written as an
  independent navigation target into the browser-style back/forward history shared with sessions; after
  entering Automations from a session, the top "Back" returns to the original session and "Forward"
  re-enters Automations. When a session creation card opens details with an `automationId`, that ID is
  kept in the navigation entry so Forward restores the same details; recommended prompts may carry a
  renderer-local `automationTab` intent, and Forward restoration still switches tab provided the target
  tab is actually visible. History replay must not push duplicate entries or truncate its own forward
  branch. Mobile `/remote` does not show Automations and must not generate such navigation entries.

```text
User selects task A
      |
      v
[task A] --open Automations--> [automations / automationId?]
      ^                              |
      |----------- Back ------------|
      |----------- Forward ---------->

History entry identity: workspaceIdentity?.trim() || workspacePath
Path execution semantics: workspacePath
```

- The scheduled task create entry is a split button: the main left button reads "创建定时任务" /
  `Create scheduled task` and goes straight to the UI create form; only the right arrow expands the
  single-item "去会话中创建" / `Create in chat` menu, whose item has no icon. The adjacent idle-time
  button uses the same action phrasing "创建闲时任务" / `Create idle-time task`, not just the task type
  name.
- The Automations main view and edit pages reuse shared menu rules: adjacent options in Dropdown Menu,
  Context Menu and Select popovers keep a 2px vertical gap; creation-method, task-action, toolbar and
  schedule menus must not override it to a zero-gap list.
- The top bar of a non-empty list keeps a manual refresh button left of the create entry; during refresh
  the icon spins and the button is disabled. Refresh re-fetches scheduled tasks, idle-time tasks and,
  when the gray release is on, the idle-time available quota, and updates the time-text baseline.
- The Project selector of the manual scheduled task form takes TabStore as the candidate authority:
  besides local projects that are still open on the left of the current window and available, it keeps
  one logical "no-project session task" option. It displays as "不在项目中工作" (Work outside a project)
  with the `MessageCircle` icon, consistent with the session side; it must not expose the conversation
  backing workspace's `default` directory name or use the ordinary `Folder` icon. Multiple conversation
  backing workspaces are one logical option and bind only to the canonical conversation workspace
  resolved by the service; non-canonical conversation workspaces from persisted leftovers or test
  directories are cleaned during restore and still merged at the selector boundary, so two no-project
  options never appear. The backing workspacePath is used only for model preview, save and dispatch,
  never as display text. `recentProjects`, closed / directory-unavailable old projects and remote
  workspaces are not mixed in. The target cannot be changed after creation; existing remote automations
  can still be viewed and managed, with no data migration. Idle-time tasks still bind only to real local
  projects and show no no-project option.
- When the new form has neither a canonical conversation workspace nor a valid local project candidate,
  workspace selection converges to `null`, a plain weak hint asks the user to open an available project
  first, and creation is disabled; neither model preview nor submit may fall back to
  `defaultWorkspacePath` or an unavailable directory. When candidates return, keep the current selection
  if still valid, else the default target if still a candidate, else the first valid target. Editing an
  existing task is not affected by the current candidate filter and keeps using the persisted
  `workspacePath` / `workspaceIdentity`.
- "Create via chat" on a desktop remote workspace must not bypass the local-project restriction; mobile
  `/remote` fully hides Automations navigation and routes, and a stale route falls back to chat.
- When "Create via chat" switches back to the current workspace's session draft, the input is prefilled
  with the sendable Showcase text "每个工作日 9 点，汇总当前项目的代码变更和待跟进事项。" (every
  workday at 9:00, summarize the current project's code changes and follow-ups), a one-sentence example
  of "cycle + project scope + task goal"; it is never sent automatically and the user can edit it.
  Desktop continuous and ordinary Web drafts use the same prefill semantics; mobile `/remote` does not
  expose this entry.
- The workspace selector must pass the full workspace identity; selection state, model preview, save and
  dispatch all decide by `workspaceIdentity?.trim() || workspacePath`, never passing only
  `workspacePath` and looking up candidates afterward. When it reuses the ordinary session workspace
  menu, the scheduled task project chip shows no detach `X`, but the dropdown keeps one fixed "不在项目中工作"
  item reusing the session-side copy, `MessageCircle` icon and selected state; the conversation backing
  workspace is no longer rendered as an ordinary project row. Entering an existing task's details must
  also restore the purpose by matching the automation's workspaceKey against the current canonical
  conversation workspace candidate: on a match the locked project field keeps showing "不在项目中工作"
  and `MessageCircle`, not `default` and a folder icon; unmatched historical targets fall back to the
  ordinary path name. Ordinary session drafts keep `X` and "不在项目中工作"; global hover/focus
  interaction must not be changed for scheduled tasks.
- The scheduled-task creation card at the end of a session turn is the final-state projection of this
  turn's tool results, not a history list of every successful `CronCreate`. The UI folds successful
  `CronCreate` / `CronDelete` by `automationId` in order: a later successful delete removes the matching
  creation card, a failed or cancelled delete does not affect the card; ordinary tool history is still
  shown in full. Multiple undeleted creations are shown in creation order.
- Clicking "Go to scheduled tasks" on an in-session `CronCreate` success card must carry the result's
  `automationId` into the scheduled task main view; once list data is ready the matching task details
  open directly instead of staying on the list. The navigation target is renderer-local one-shot state:
  consumed immediately after successful location; if the list finishes loading and the target is still
  not found, show a "task does not exist" notice, consume the intent and stay on the list so stale
  intents do not linger. This state must not enter relay, main or session realtime state.
- The created-task area shows at most 8 cards at once: desktop two columns by 4 rows, mobile one column
  by 8 rows; the rest scrolls vertically inside the card area without changing data loading and sorting.
- Created-task cards show no project name or folder icon; title, instruction, run status and count are
  the main information. The task's workspacePath / workspaceIdentity is still kept for edit, execution
  and isolation.
- A card's "next run" time is relative within 1 month and local absolute time beyond 1 month, so distant
  tasks do not show hard-to-read huge day counts.
- A full-width divider separates the created-task area from "More inspiration" below; it uses the
  `card-border` semantic color consistent with the Card border so the hierarchy is clear in Light and
  Dark.
- The home "scheduled templates" come from the `scheduled-task` scene in the `clientScenesService.list()`
  response. The card title is the current-language `labels` of the prompt item; the description and the
  form instructions are the current-language `contents`; a template whose title is empty in both
  languages is rejected. `defaults.cronExpr` references `options.cronExpr.items` of the same scene, and
  the actual cron is only the current-language `contents` of the referenced item. The cron must pass both
  the Service validity check and the Automation editor lossless round-trip check, so clicking a template
  never has the builder silently rewrite it without edits. The bottom schedule text is generated by the
  client's existing cron parsing and localized display logic; server `labels` are not the source of
  truth for the displayed schedule.
- A remote cron must be validated during template mapping with the same parser as the final Service
  validation; templates with a missing reference or invalid cron do not enter the card list or create
  chain. The final validation in `AutomationService` before saving stays and must not be removed because
  the UI already filtered.
- Clicking a template only opens the create form prefilled with title, cronExpr and instructions; it
  creates no task and sends no message. On click the current-language configured values are copied into
  an ordinary user draft; after entering the form, language switches, Client Scenes re-requests or
  background config refreshes must not overwrite user edits. Remote template objects and option/default
  metadata must not be written to automation persistence; only the final form values confirmed by the
  user may be saved.
- If the Client Scenes request fails, returns a business error, lacks the `scheduled-task` scene, or all
  templates are rejected by validation, the loading state must end and the scheduled template area shows
  the localized "no templates available"; manual creation, the creation limit, project candidates,
  `workspaceIdentity?.trim() || workspacePath` isolation and the existing Service/Repo/Scheduler chain
  are unchanged.
- Scheduled and off-peak templates are mapped from one SWR in-memory cache through the shared
  `useClientScenesResource()`. Only a cold cache shows template skeletons; with a cache, the last-known-good
  catalog shows immediately and revalidates in the background without falling back to skeletons.
  Repeated mounts inside the 10-minute dedupe window do not request again; there is no polling. A failed
  revalidation keeps the displayed catalog; a failed first request still degrades to an empty catalog.
  The cache is isolated by the injected Client Scenes Service authority and never enters task
  persistence; a locale change only remaps cached content without a network request. After a Desktop
  window is closed/hidden or a Web page goes to the background, only an actual `hidden -> visible`
  transition bypasses the dedupe window and forces revalidation; multiple consumers of the same
  Service/cache authority coalesce into one request; ordinary focus does not force invalidation.

```text
clientScenesService.list()
        |
        +--> pending: visible template areas show two skeleton rows, manual create entry stays available
        |
        v settled
scheduled-task remote candidate catalog -- cron contents local validation/parsing --> template cards / failed empty catalog
        |                                                   |
        | background refresh only updates the candidates    | on click, copy current-language values
        v                                                   v
next time entering the list                         AutomationEditView local draft
                                                            |
                                                            `-- user confirms --> AutomationService --> automation record
```

- Template icons interpret the remote prompt item `img` as a Lucide canonical name and load it
  dynamically by name; no image URL request is made. SVGs use `currentColor` to inherit the icon slot
  text color; a blank value, unknown name or module load failure falls back locally. The fallback icon
  maps the remote item id's known task semantics to Lucide: morning/standup use `Target`, risk/CI use
  `Activity`, release/file use `FileText`, any other dynamic template falls back to `List`; `imgs` does
  not take part in icon selection and no in-page approximate icon is introduced for unknown server
  templates.
- The Settings page still exposes the Automations section through `settingsPageConfig.ts` and renders
  `AutomationsSection` directly; this entry has no Automations `main` anchor of the workspace main view,
  so its Toast must use the full-window centering fallback. If this compatibility entry is removed in
  the future, delete this fact statement together.
- The scheduled task main view renders no `WorkspaceHeader` or draft title-bar placeholder, avoiding a
  chat / project top bar.
- When a scheduled task management action fails, the underlying RPC / Agent error is written only to the
  UI logger for diagnosis; the main view must not expose the raw error as a persistent red banner or
  raw-text toast. The user sees only a short localized hint matching the current action, avoiding
  duplicate feedback and leaking implementation details such as session, command or reasoning effort.
- Automation management UI reports three lifecycle events that can be correlated with real run results
  via `automation_id`: the manual-create interface terminal state `automation_create_result`, the
  run-now intent confirmation `automation_run_now_ck`, and the delete intent confirmation
  `automation_delete_ck`. The event area is fixed as `app.automations`; list and edit pages are
  distinguished by `action_source` and must not report twice. Template creation carries the stable
  `template_id` delivered by the config platform, `item-*` values pass through unchanged, with no
  compatibility with or normalization to the old unprefixed local IDs. Titles, task instructions,
  workspace info and full endpoints are never reported; a custom provider may carry only its hostname;
  reporting failure must not interrupt the business flow.
- `automation_create_result`: on success `error_code` / `error_msg` are empty; on failure `error_code`
  is a fixed enum `limit` / `timeout` / `network` / `auth` / `validation` / `unknown`. Classification is
  done locally by known error codes or error patterns, matched in the enum order above; an unrecognized
  error or missing error text uses `unknown` and does not claim a precise root cause. A non-empty
  `error_msg` is uploaded as `[redacted]`, an empty one stays empty; no paths, URLs, credentials or
  original text fragments are uploaded.
- A successfully completed `CronCreate` tool step in `agent_step` must carry the `automation_id` newly
  generated by that tool result; running, failed, cancelled steps and other tools must not guess or carry
  this field. This ID means "the task created by this step" and must not be mixed with the task ID of the
  current automation dispatch context.
- The main view container uses the ordinary workspace background and a bounded content width; desktop
  and ordinary Web keep the same layout semantics, and mobile `/remote` hides Automations per the
  product boundary above.

```text
CronCreate(A) success  -> final cards: [A]
CronDelete(A) success  -> final cards: []
CronCreate(B) success  -> final cards: [B]
assistant turn complete -> render [B]
```

# Compatibility

- The title, schedule and Instructions input frames of new and edited scheduled tasks follow the
  settings search box: large input size, `h-9` (single-line controls), `rounded-xl`, `bg-input` and
  `border-input-border`, inheriting the standard input hover/focus border states. Title and Instructions
  content use 12px padding (`px-3` / `p-3`); Schedule keeps 8px compact padding and its delete action
  slot. The toolbar inside the composite input and the schedule tags keep their own compact levels.
- The frequency, date, time and custom-period submenu triggers inside the Schedule row are
  `rounded-full` pills; the expanded menu container and options keep the standard menu style, not pills.
- The desktop `continuous` session main chain is unaffected; this change only switches the UI main view
  and does not modify stream, snapshot, queue or owner commands.
- Mobile Web remote control does not show Automations and adds no separate runtime, host or remote
  control business state.
- Existing tasks of remote workspaces stay isolated by `workspaceIdentity?.trim() || workspacePath`; no
  new remote tasks are added.
