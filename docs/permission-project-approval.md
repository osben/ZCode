# Permission Approval and Project-level Allow

## Model

Permission options are modeled as "display copy + real protocol response":

- `allow_once`: allow this tool call only.
- `allow_project`: allow the same tool/rule later in this project; the response carries
  `permissionUpdates`.
- `deny`: deny this tool call.

Trusted official CUA has one restricted capability-group semantic: after the user picks
`allow_project` once for official CUA, later official CUA tools in the same project share that one
grant — no separate dialogs for `get_app_state`, `left_click`, `key`, `drag`. The exception widens
matching only inside the official CUA tool family; it does not change `allow_once` semantics or
widen ordinary MCP tool permissions.

## Protocol constraints

`interaction/requestPermission`, `permission.requested` events and the pending permission snapshot
must all carry `options`. Each option includes:

- `optionId`: stable option id.
- `kind`: UI display semantics.
- `name` / `description`: display copy.
- `response`: the `ZCodePermissionResponse` returned verbatim to the agent when the user picks the
  option.

Legacy apps pass the verdict through via option.response; V4 hands the stable optionId to the
agent's registered interaction handler and never derives a response from UI order. Full access is
the separate commit action below, not a plain allow.

## Deny with feedback (V4)

A V4 permission snapshot may declare `freeText: true` — "deny may carry feedback". It is an input
capability, not a fourth verdict, and does not change the `allow_once` / `allow_project` / `deny`
protocol.

- Desktop, web and mobile `/remote` share one `PermissionDialog` and `resolveInteraction`; desktop
  keeps `desktop-continuous`, web/mobile keep `web-remote-replayable`.
- Submitted feedback travels as `resolveInteraction.answer.freeText` and enters the same
  provider-visible denied `tool_result` with `optionId: "deny"`; no new real user message, `steer`
  or permission event type.
- The denial content starts with the stable Deny copy; non-empty feedback appends in a fixed
  format: stable copy, a space, `To tell you how to proceed, the user said:`, then a newline with
  the `<trimmed feedback>`.
- Blank feedback falls back to the stable Deny copy; `freeText` carried by allow options is
  ignored; unknown options still fail closed as deny.
- The input is its own UI navigation row, numbered after the permission options (`5.` with full
  access, `4.` on older capability sets), selected and highlighted separately from Deny; focus
  still defaults to the first permission option. Up/down and Tab / Shift+Tab cycle between
  permission options and the input row; the matching number key (full option set: `5`) focuses the
  input without submitting; IME candidate selection does not switch rows. Permission-option number
  keys match their row numbers (`1`–`N` including Deny; `4` is Deny in the full-access layout, see
  ISSUE-057) and also only select and focus, never submit; only Enter or confirm submits (the
  dialog auto-focuses on open to avoid approving while the user is still typing — see
  `specs/ui-accidental-action-guards.md`).
- The input row and permission options share one visual group with 4px row spacing; 12px stays
  between tool details, option group and the bottom confirm area. The input box stays outside the
  permission `listbox`, not changing the options' accessibility semantics.
- With non-empty input, Enter or confirm submits Deny with feedback; blank input: Enter does not
  submit and confirm is disabled. A plain Deny confirm still carries existing non-empty feedback;
  Allow ignores feedback; Escape only exits input focus; the 5-line cap stays.
- The PermissionDialog feedback input is an auto-wrapping, content-growing multiline textarea; its
  row number vertically centers on the textarea's first text line and does not move as the box
  grows (plain permission options stay centered); max 5 lines and 4,096 characters, scrolling
  inside beyond that. The shared `resolveInteraction` schema does not restrict `freeText` on other
  interactions — AskUserQuestion, Plan and generic user-input behavior must not be narrowed.
  Unsubmitted drafts live in renderer memory only; pending commands keep storing only sensitive
  summaries.
- Legacy v3, TUI and bots do not declare the capability and keep the plain Deny path.

```text
UI focus (fullAccess): [1 Allow once] <-> [2 Allow project] <-> [3 Full access]
       ^                                                          |
       +---------------- [5 Feedback] <-> [4 Deny] <---------------+
                               |
                                                        Enter / Confirm
                                                               v
                                            existing Deny + answer.freeText
```

## Dialog display semantics

- `reason` stays attached to permission requests for policy diagnostics, logs and recovery; the UI
  must not treat every policy reason as a user-facing hint.
- `High risk tools require explicit approval` and `Tool has side effects and requires approval` are
  internal policy notes, never shown in the dialog. The dialog already expresses approval state via
  "waiting for confirmation", tool details and action options; repeating these notes adds nothing.
- Concrete `description`, commands, file changes, URLs and other actionable tool-input details keep
  their existing display rules.

## Rule generation

`allow_project`'s `permissionUpdates` uses `addRules`:

- `behavior: "allow"`
- `toolName` from the permission request.
- For non-Bash tools, `ruleContent` still best-effort extracts URL, path or glob from the
  permission input; when nothing extracts, record the tool name only.
- Bash rules come from the CLI's AST-aware rule policy as a stable command prefix or exact rule;
  app, host, main, relay and TUI never re-derive from input.
- Only CUA tool entries verified by the official plugin authority secret gate carry the runtime
  `permissionCapabilityGroup: "official_cua"`. Their `allow_project` suggested rule uses the
  reserved key `zcode:permission-capability:official_cua` inside the existing
  `{toolName, ruleContent?}` shape — no new wire field, never derived from spoofable MCP
  server/tool names.
- The capability-group reserved rule carries no `ruleContent`. It expresses the user's grant of the
  whole official Computer Use capability group in this project, not string matching against some
  coordinate, path or app input.

Bash stable prefixes use the existing `"<prefix>:*"` encoding; commands that cannot be safely
normalized, contain redirects/dynamic structure, or are high-risk broad actions save the full
command as exact. A compound command yields at most five independent rules; over the limit, the
whole string falls back to exact. Read-only invocations are auto-allowed by the Bash readonly
policy with no redundant rule.

`suggestedPermissionUpdates` must enter the `permission.requested` durable event and the pending
snapshot. Desktop continuous, mobile replayable, refresh recovery and TUI display and return this
one authoritative copy — never compute different authorization scopes separately.

## Official CUA capability group boundary

Group matching needs both "persisted rule" and "the current tool entry's trusted authority":

```text
official plugin config + authority secret
              |
              v
register MCP tool -- verified? -- no --> ordinary exact-tool permission
              |
             yes
              v
tool entry carries permissionCapabilityGroup=official_cua
              |
     first allow_project
              v
project ruleset stores official_cua group rule
              |
   later tool in same project
              v
stored group == current trusted tool group ?
        | yes                         | no
        v                             v
      allow                      normal ask/deny policy
```

Must accept:

- Same `projectId` under the same verified official CUA authority: after the first
  `allow_project`, other official CUA tools hit the group rule.
- Old exact-tool, Bash prefix/wildcard and tool-only rules keep their semantics.
- A permission request replayed from desktop continuous onto mobile `web-remote-replayable` returns
  the same option response; project rules persist once, in the Agent's session store.

Must reject or fall back to normal asking:

- The next call after `allow_once`.
- Different `projectId`, missing persisted session, or project identity drift.
- Third-party MCP reusing the same server/tool names, faking the official plugin id, shadowing
  same-named tools, or authority verification drifting.
- Ordinary MCP, node_repl, browser-use and other non-official-CUA tools.
- The reserved key written manually while the current tool entry has no trusted official CUA
  capability: fall back to normal ask/deny, never a plain exact-toolName fallback.

Never encode the capability group as `mcp__computer-use__*`, a server-name wildcard or a
plugin-name wildcard — all spoofable by third-party MCP and unusable as authorization authority.

## Storage compatibility

Project permissions stay in `local_setting`'s `permission/ruleset` JSON: no new SQL migration, no
schema-version change, and the strict `PermissionRuleValue` `{toolName, ruleContent?}` shape is
unchanged; old exact, `:*`, wildcard and tool-only rules are kept verbatim. The capability group
uses one reserved `toolName` key old schemas can parse and old Agents safely ignore; Bash
prefix/wildcard rules are instead matched safely per invocation by the AST evaluator so old broad
rules cannot swallow a compound's appended commands. Historical rulesets must not be bulk-rewritten
when no new grant happened.

This encoding is the mixed-version and rollback boundary: strict-schema old desktop/mobile/bot
displays and returns the rule verbatim; the new Agent interprets it together with the current
trusted tool entry's capability. Rolled back, the reserved key matches no real tool — worst case it
asks again; it never widens authorization or makes a pending permission unparseable.

This covers common permission requests (shell commands, file paths, network URLs) while keeping
rule interpretation with the agent.

## Acceptance

- Dialogs without the full-access capability keep three options: allow once, always allow in this
  project, deny; with it, the four options below plus the optional fifth feedback row.
- Clicking "always allow in this project" returns a response containing `permissionUpdates`.
- Later identical rules do not re-prompt.
- The official CUA project option explicitly shows the "Computer Use" scope; after choosing it,
  `get_app_state → left_click → key → drag` in the same project prompts only the first time.
- Same-named third-party MCP, different projects and authority drift cannot reuse the official CUA
  group rule.
- The dialog read-only displays new prefix/exact scopes with no editable pattern input; multiline
  or very long exact rules show only a bounded first-line summary; the full rule passes through
  only with the response, never into the option DOM.
- After refresh/replay, scope copy and raw `permissionUpdates` match the first request.

## Dialog "Full access" (Todo158)

When the Agent supports the full-commit capability, ordinary main-task approvals offer in order:
allow once, always allow this command, full access, deny; with `freeText` declared, feedback is the
fifth row. The command's project-allow keeps the Agent's prefix/exact rule; files, network, MCP and
CUA keep their own scope copy.

Command approval item 2's description is "项目范围内，后续相同命令不再询问" (in this project, the
same command will not be asked again); item 3's is "授予 Agent 完全访问权限，不再确认。" (grant the
Agent full access, no more confirmations). The copy does not change the authorization scope or Plan
boundaries below.

Only the dialog's full-access action batch-switches the current task runtime, that task's Composer
and all admitted-but-unexecuted queue items (including held/Guide) to `yolo`. Each item's
`planEnabled` is preserved separately; other config, body, attachments, order and delivery are
unchanged; existing Plan tool restrictions still apply. The ordinary Composer menu still edits only
the draft. The current turn keeps executing; no new message is created and project
permission/mode, ruleset and Composer Recent are untouched.

```text
resolveInteraction(fullAccess) → session FIFO → registry + broker claim (Hook bows out)
 → queue consumption barrier, pin target IDs → SQLite atomic execution / session_input / receipt
 → Runtime memory → SessionModeChanged (mode + permissionGrant + target IDs)
 → V4 config/queue projected in one pass → Composer consumes once per interactionId
 → current broker allow → current tool continues
```

- `fullAccessOption` is a standalone optional capability field; the original `options` list stays
  legacy-compatible; only the new UI merges it as the third item. Old UI ignores the field; old
  Agents do not declare the entry. The static response is deny — an unknown client cannot mistake
  it for allow.
- AskUserQuestion, ExitPlanMode, workflows requiring independent confirmation and child-origin
  approvals do not declare the capability; children keep their own approval — switching the parent
  runtime that happens to display them never counts as the child getting full access.
- The Agent registry validates session/interaction. Cancellation before the transaction, a Hook
  already won, already denied, or late answers never elevate; duplicate submits of the same request
  share one operation. A post-claim failure keeps the approval open for explicit retry or deny.
- The SQLite transaction saves the current execution state, the target queue's permissions and a
  receipt deduped by interactionId — no new tables. Transaction failure rolls back everything;
  post-commit retries use the original pinned targets and exclude later submissions.
- Guide consumption and reserve/promote coordinate with the authorization barrier; in-flight
  consumption/promotion completes first and approval can retry. On event publish failure, later
  mode changes/queue consumption first restore the committed events; projection-failure retries
  rebuild from the original authoritative log, preserving later event order. Tools are released
  only after the projection commits.
- Each full-access attempt manages its own wait: after submit/projection failure the barrier lifts
  and legacy answers or timeouts that already arrived or arrive later still settle per their
  original semantics; with no answer, the approval stays for explicit retry/deny. A retry must
  build a new barrier — never reuse a consumed failure notification to release early.
- Cold recovery uses only valid receipts belonging to the current session as Composer grant
  markers; invalid records or unknown extension fields are diagnosed, skipped, old in-memory
  markers cleared, and task recovery continues. Idempotent retries of the grant action strictly
  reject corrupted receipts and never re-authorize against the current queue.
- The Composer persists processed grant IDs within the existing workspaceIdentity/session draft;
  ordinary snapshots and edit-withdrawal cannot re-trigger an old grant. Withdrawing an edit also
  restores each queue item's recorded mode, Plan, model and reasoning; fields missing on old items
  keep the current draft. Scope switching does not modify other tasks; new submissions follow their
  own explicit config.
- Desktop continuous and mobile replayable keep their delivery/reconnect contracts; process restart
  recovers execution state and grant markers; the queue keeps the existing cold-recovery discard
  rules.

Implementation and acceptance evidence: [Todo158](working-memory/provider-refactor/steps/todo-158-permission-dialog-full-access-and-queued-mode.md)
and the [coverage matrix](testing/conversation-session-e2e-coverage-matrix.md). Pending E2E does
not automatically count as manual admission or a full mobile-chain pass.

## Command preview integrity (2026-09-28)

- The Bash command in a permission card auto-wraps by default, showing at most three lines;
  "展开命令" (expand command) appears per actual rendered overflow.
- Expanded shows the full command, at most ten rows tall, scrollable vertically to the end;
  collapsible, keyboard-operable; long paths on narrow screens never widen the page.
- While awaiting authorization, only input is shown — no output or "no output" placeholder. The
  empty-output hint after real execution keeps its existing behavior.
- Expansion state belongs to the command-preview component only; permission responses, execution
  state, desktop continuous and mobile replayable chains are unchanged.
- Browser regression covers desktop/mobile widths, dark/light themes, long-command
  expand/collapse, end reachability, short commands without the expand button, and authorization
  buttons staying usable.

Verification outcome: `permission-full-access.test.mjs` shared-UI browser E2E 8/8 pass (390/1200
width, dark/light); related unit tests 14, `pnpm typecheck`, `pnpm lint` (0 errors) and the
architecture gate pass. Electron full-chain and mobile relay integration tests were not run; the
browser fixture stays pending manual admission.

The expand control uses secondary text at `text-ui-sm`: zh-CN "展开命令 / 收起", en "Show full
command / Collapse", with a direction arrow on the right. It is a link button — horizontal padding
and border removed, always transparent, underline on hover / focus-visible; its text strictly
left-aligns with the command body while keeping the default button height as a touch target.

The command scroll viewport extends to 4px inside the card's right edge; the body keeps its
indentation and usable width via in-viewport padding; the collapse button sits outside the scroll
viewport and does not scroll with the command.

The `$` prompt marker shares the command's scroll viewport, disappearing when scrolled past the
first line and reappearing at the top — never pinned mid-command.

Keyboard path: with a long-command expand button present, Shift+Tab from the first permission
option returns to the command button; Tab returns to the first option; after expanding, Shift+Tab
again enters the command scroll viewport. Expanding/scrolling never submits authorization. Short
commands without the button keep the existing option cycle.

## Group task scope

Feishu/Lark group tasks use `SessionInfo.permission.scope = "session"` before tool execution. The
first trusted group input initializes an empty session ruleset; later inputs retain only that
task's explicit approvals. Session-scoped tasks do not read or write project approval memory.
Existing private/desktop tasks without this marker keep project semantics. An explicit owner mode
change remains session configuration; message text and model output never set the marker or grant
permissions.

```
trusted group input → persisted session scope → tool permission check
                                             → session grants only
owner approval      → same pending request   → session grant update
```
