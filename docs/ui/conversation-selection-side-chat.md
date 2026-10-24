# Conversation Selection Side Chat

## Feature summary

The main session timeline of desktop Electron and desktop Web supports selecting single-row text, with two actions:

1. **Add to current task**: appends the selection as a structured reference chip to the main composer.
2. **Ask in side chat** (在辅助对话中提问): prefers appending the selection to the currently active `selection_side_chat` child tab; when no side chat is active it creates a new hidden child and continues a multi-turn conversation in the right Side Pane.

The empty-panel start page and the top `+` menu of the right Side Pane also offer a **辅助对话** (side chat) entry. The entry shares the creation capability of the main `SessionPane` with the selection action, but the fixed entry creates and activates a new side chat tab each time. The same parent session can keep several children, composer drafts and blocking interactions at once.

The main composer's `/` panel additionally offers the App-level command **`/side`** and its equivalent alias **`/btw`** (to fit different user habits, shown as separate entries in the panel). Selecting the bare command from the panel creates and activates an empty side chat tab, removes the command token from the input, and sends no message; submitting `/side <text>` or `/btw <text>` directly sends the text after the command as the new child's first ordinary message at once. Arguments support text only: when a file attachment, code comment, web/PPTX element or selection reference exists it is not consumed as an App command and goes through the main session's original send logic. The two commands are wrapped and injected by the rendering layer outside the CLI slash catalog and do not modify the CLI command catalog; if the CLI returns a same-name command, the CLI wins and the App command is hidden and not consumed. The draft state (no session created yet), the side chat's own composer, read-only and the mobile viewport do not offer these two commands.

Mobile registers no selection entry; "more details" is not part of this feature. The side pane is for explanation and light exploration, allows normal tools, file edits and permission interaction, but offers no goal, edit/retry or fork.

## Focus ownership of Esc stop

Main and side conversations being visible together does not mean both own keyboard focus. With the right panel open, Esc may only stop the `SessionPane` the keyboard event belongs to; the pane DOM on the browser event path decides, not tab visibility or listener registration order. When focus stays in an already-stopped conversation, another Esc does not stop the other conversation; switching input focus changes the target. With the right panel open and focus outside the conversations, no conversation is stopped; after the panel closes, Esc stops the main area's current conversation by default without clicking back into the input first. In split view only the main area's existing focused pane gets this default entry; a hidden side chat takes no part. The default entry is delivered by the Shell's existing panel toggle and visibility state, adding no focus or panel state. It is revoked on open and enabled after closed and no longer visible; desktop and mobile layouts follow the same rule. Dialogs and input suggestions that already consumed Esc keep priority, and stop buttons still route per their own session.

```text
Esc -> dialog / already consumed -> no stop command
    -> right panel open -> SessionPane that owns the keyboard event -> its own session stop
    -> right panel closed -> main area's focused SessionPane -> its own session stop
                                      `- idle -> no stop command
```

SSC34: the main session runs first and the side chat later, with focus in the side input; Esc stops only the side chat, repeated presses do not affect the main session, and only after switching back to the main input can the main session be stopped.
SSC35: the side chat runs first and the main session later, with focus in the main input; symmetric assertions.
SSC36: both main and side run; with the panel open, Esc outside the main area stops nothing; after collapsing the panel and moving focus to a blank page spot with no overlay, Esc stops only the main conversation; reopening the panel confirms the side chat keeps outputting. Component regressions cover the default entry in desktop/mobile layouts, the hidden workspace gate, and dialog/defaultPrevented still taking priority once the default entry is enabled. All these scenarios verify the unstopped side keeps receiving streamed body; they use a local controlled-stream E2E so a real provider does not end early. This focus rule is shared by the desktop/Web renderer and does not change the session owner, stop protocol or continuous/replayable transport. Mobile has no side chat entry; this round does not extend combinations of remote transport, theme and locale.

## Clarification log

| Boundary | Decision |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| child baseline | Derived from the parent session's latest stable persisted boundary; while the parent turn is generating, the committed user input is kept and unfinished assistant/tool increments are excluded |
| Selecting a history row | Affects only the reference content, not the child's fork baseline |
| Lifecycle | Main task advancing, switching tasks and long disuse never auto-expire; no TTL/count reclamation and no expired card |
| Close | Closing a tab, closing others/all, parent task delete/archive and window exit all close the live runtime and remove the tab |
| Restart | Tabs, drafts and parent-child UI bindings are not restored; hidden child history may remain in SQLite |
| Missing child | `proto.sessionNotFound` removes the tab directly; this selection action can recreate it once, no invalid page is shown |
| blocked | When the main session composer is hidden by Permission/AskUserQuestion/ExitPlanMode no overlay is shown; when the side pane is blocked "add to current task" is still allowed and the side pane action is disabled |
| Capability limits | The side pane allows normal send, compact, tools and permission interaction; protocol and UI both forbid goal, edit/retry, fork |
| assistant selection | Completed and streaming assistant body, Markdown and code can all be selected; the selected text is frozen when the action happens and later deltas do not rewrite the reference |
| Send payload | New sends use a `# userselect:` / `userselect` structured block whose array elements keep only `{ text }`; source fields are used only for de-dup before sending; old full structured blocks stay readable |
| Fixed entry | The empty-panel start page and the top `+` menu both offer "辅助对话"; each click creates a new tab; usable while the main task is running/blocked, hidden with no active task and on mobile |
| `/side` `/btw` commands | App-level slash commands and equivalent aliases, injected by the rendering layer outside the CLI catalog without changing the CLI (the CLI wins on a same name); a bare command selected creates an empty side tab and removes the token, with a text argument it submits the child's first message; attachments/structured context are not consumed; not offered in draft state, in the side chat itself, read-only or mobile; description copy adapts to locale in Chinese/English, and search keywords match `side`/`btw` and "辅助对话" |
| Multiple tabs routing | One parent task can open several side chats at once; a selection is appended to the currently active side tab, and when the active item is not a side chat a new one is created and activated |
| History visibility | Parent history remains provider context, while the child timeline, search, paging, turn navigation and visible row count all start blank |
| Goal parent task | `active`, `paused`/`budget_limited` and `complete` all allow creation; the child copy removes `anchor.goalBoundary` from the body and copies no session target, verifier entries, queue or active work |
| Visual density | The selection overlay is about 32px high with 12px font, compact padding, `rounded-lg` and `shadow-md`; user copy uses "辅助对话" uniformly |
| fork switch | When the parent task has side chats and forks into a child, only the parent-bound tabs are hidden; the child's expanded Side Pane shows the start page, and switching back to the parent restores the original tabs, children and drafts |

## State and ownership

```text
valid selection in the main timeline
    |
    +-- add to current task ----> main composer reference chip
    |
    +-- side pane action
           |
           v
look up current Side Pane activeTabId
           |
           +-- live side chat tab of the current parent task ---> validate child, activate tab, append de-duplicated reference
           |
           +-- non-side tab / no active tab ---> create hidden child, open new tab, append reference
           |
           +-- same creation gesture still pending ------> merge the pending promise, avoid double-click duplicates

Side Pane start page / top + menu / main composer `/side`, `/btw`
    |
    +-- no active task / draft state / mobile --> no "辅助对话" entry, no `/side`, `/btw` in the `/` panel
    |
    +-- has active task (including running/blocked)
           |
           +-- bare command click / select --------> create hidden child, open new tab, focus empty composer
           |                             (remove the command token from the input)
           +-- submit with text argument ----------> create and register child, first text sent as child startNow, open new tab
           |                             (parent task queue/guide unchanged)

main task advancing / switching tasks / long disuse
    ---> child lifecycle unchanged

close tab / parent task delete-archive / sessionNotFound / app exit
    ---> close live runtime ---> remove tab
```

| State / fact | Authority | Renderer state | Persistence |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------- | ------------------------------ |
| child conversation and tool/permission state | CLI runtime/session store | V4 projection | SQLite hidden child |
| current-window parent -> children/active | renderer Side Pane registry | tabs unique per child, `activeTabId` decides the selection target | not persisted |
| composer draft and pending references | the corresponding composer | session/tab scoped state | not persisted |
| sent reference chip | CLI session user message | `# userselect:` text array | persisted with the user message |
| workspace isolation | session workspace ref | `workspaceIdentity?.trim() \|\| workspacePath` | tab key and command route |
| live list visibility | CLI sessions-index/task-index filter | task list cache | root query excludes parented children |

## Same-model Start recommendation

Before `/side <text>` / `/btw <text>` creates the child and submits the first message, the provider/model/thought already in effect in the parent session snapshot is used to judge the same-model Start recommendation; the parent Composer's uncommitted model draft is not read. When no complete verifiable inherited selection exists, the original Host inheritance behavior continues and the recommendation is skipped.

Confirming the switch passes the full `firstInput.modelSelection` with the single `createSelectionSideSession` command, and the Host creates the child with it and starts the first input; "不了" (no thanks) omits the field and keeps the original inheritance; closing the dialog sends no command, creates no child and keeps the original input. A bare command and the empty side-pane entry do not recommend. The original ACK admission, de-dup and continuous/replayable boundaries are unchanged.

## Selection and reference contract

- The listener belongs to `SessionPane/ConversationTimeline`, does not depend on the input DOM and does not listen on the Side Pane.
- Single-row selections made by mouse and keyboard are supported. Selectable content is user/assistant body, code, reasoning and tool results. The assistant selectable region must sit on a real DOM container and must not depend on Markdown component props that do not forward `data-*`; this applies to both completed and streaming assistant.
- A streaming assistant reference is frozen at the user's action click by the current `Selection.toString()`, and later model deltas do not write back to the created `ConversationSelectionReference`.
- A selection endpoint landing in a control, menu, status label or blocking dialog produces no entry; within the same selectable region, a selection spanning from ordinary Markdown into a table cell is not a control selection because of the `select-none` table toolbar sitting between them in DOM order, and still produces the entry. Cross-row, whitespace-only and already-unmounted virtual rows produce no entry.
- Scroll, Esc, selection collapse, task switch and entering a main-session blocked state close the overlay.
- `ConversationSelectionReference` contains `id`, `sourceSessionId`, `sourceRowId`, `contentType` and the original `text`. The de-dup key includes all source fields and the text; identical text in different rows is not a duplicate.
- At most 8,000 characters per item, 8 items per composer and 16,000 characters in total. Exceeding is rejected atomically with a localized hint, without truncating or clearing existing references or the draft.
- The pre-send composer reference keeps all source fields for exact de-dup, limits and pending hover; at send time only the `{ text }` array is appended to the `# userselect:` structured block with language tag `userselect`, so the session, row, content type and internal id are not exposed to the model. After parsing, the timeline shows only the body and reference chips, and the hover of a sent chip shows only the persisted selected text.
- The old full structured block `# Conversation selections:` with language tag `zcode-conversation-selections` is still parsed read-only so existing history chips stay visible; new messages no longer write the old format and persisted messages are not migrated. When it coexists with Web element context, the trailing Web element block is parsed first, then the selection block.

New send format:

````text
# userselect:
```userselect
[{"text":"云计算"}]
```
````

## Protocol and runtime contract

- V4 adds the non-CAS command `createSelectionSideSession`. The parent session is given by the command envelope's `sessionId`, and the payload is `{}` or `{ firstInput: { text } }`; with `firstInput` the child reuses the first-send `sendText` admission/startNow path. The ACK result is `{ type: "createSelectionSideSession", sessionId, input? }`, and a retry with the same commandId must not create or send twice.
- The server derives the full workspace ref, remote identity, model, thought, mode, followup mode and permission rules from the parent record; the UI passes no workspace identity assembly fields.
- The child task type is `selection_side_chat` with `parentSessionId`. It copies no goal, queue, background tasks, continuation inbox or pending interaction.
- Copied parent history is marked entry by entry as `model-only`, `uiVisibility=hidden`, `providerVisibility=visible`; live and cold hydration must use the same projection policy. Hidden history does not enter the child's visible rows, total count, load-older, conversation find or turn navigator.
- A model-only boundary is written after the copied history: inherited history is reference only and does not continue the parent task; only new questions in the side pane are handled; modifying the workspace must be explicitly requested by the user in the side pane.
- The boundary is registered as a persisted `selection_side_chat` reminder with channel `history_continuity` and lifecycle `resume_history`. The atomic fork bundle stores raw text and source-aware part metadata; the child's first mount and later restores both hydrate it into a Runtime Attachment. This source explicitly skips MCS and the shared projector always outputs a user `<system-reminder>` before the child's new question, aligned with the reminder position of `/btw`; the MCS projection of other sources keeps its original rules. The tag is not pre-wrapped into the persisted body, a duplicate reminder is not appended each turn, and old side chats lacking part metadata are not migrated.
- `sendGoalCommand`, `resumeGoal`, `editUserQuery`, `retryTurn`, `forkAssistant` return `guard.selectionSideChatRestrictedCommand` for this kind.
- Live sessions-index, task-index and project/conversation/group/pinned/archive lists filter this kind; subscribing directly to the child conversation topic still works.

## First-turn reminder E2E regression (SSC33)

The formal case `conversation-session-side-chat-reminder.test.ts` runs two independent MCS/non-MCS scenarios in one default replay. After the parent session completes one read-only tool call, a bare `/btw` opens an empty child, waits for the child input to be editable, sends an ordinary question asking for a fixed reply, and waits for that reply to complete.

- non-MCS uses the default `deepseek-v4-flash` and the local replay endpoint.
- MCS adds and selects `claude-opus-4-8` through the settings page, triggering the production model-capability decision; the request is still handed to the local replay.
- Both scenarios assert: the source-aware part metadata of the fork boundary is kept; inherited history does not show in the child timeline but enters the provider context; the reminder body appears exactly once, as a user `<system-reminder>` before the new question; the parent session messages are not rewritten by the child input.
- Other `role: system` messages in the request are checked independently: present in the MCS scenario, absent in non-MCS, so disabling MCS overall is not mistaken for the side-chat source being excluded correctly. The response is pinned by a case-local synthetic fixture and the response content is not evidence of model-identity awareness. A core unit test additionally verifies restore from the actual fork bundle JSON round trip.

```text
fork: inherited history -> selection_side_chat Attachment -> child question
wire (MCS / non-MCS): user [<system-reminder>boundary</system-reminder>, question]
```

```bash
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/conversation-session-side-chat-reminder.test.ts'
```

The formal regression keeps only UI, persistence and provider request assertions; the run report and network evidence are collected uniformly by the shared E2E runner, and the case writes no extra full session dump, copied model-io or duplicate screenshot.

## Side Pane and lifecycle

- Each window and each `(workspaceKey, parentSessionId)` may have several live children at once; cross-window sync of the tab list or active target is not required.
- The stable tab key is `workspaceKey + parentSessionId + childSessionId`. The fixed entry creates a new child on every completed click; the same click merges while the command is pending, and a failure leaves no empty tab.
- Side tabs of the same parent are named by the localized "辅助对话 N"; `N` takes the smallest free positive integer among those used by the current parent task, numbers may be reused after closing, and the tab identity is always the childSessionId.
- A new reference keeps the target child's question draft; an exact duplicate only activates the target tab and adds no chip. Sibling children's drafts, references and blocked states are unaffected.
- When the Side Pane is collapsed or showing another tab, it expands and activates the target tab and keeps the other tabs.
- The empty-panel start page and the top `+` menu share one "辅助对话" item resolver; the entry appears only on desktop Electron/desktop Web with an active parent session.
- The fixed entry is not affected by the parent session running, Permission, AskUserQuestion or ExitPlanMode blocking; it appends no reference and always creates an empty child. Existing children (including a blocked one) are kept and the user can handle them by switching tabs.
- Switching the main task only hides and does not close; switching back to the parent task restores the original live session, draft and references.
- Whether the Side Pane shows the tab strip is decided by the visible tab set filtered by the current task. Even if the workspace registry still stores hidden tabs of other tasks, an empty visible set for the current task shows the "打开标签页" (open tab) start page and never an empty tab shell.
- All close paths call the child `deleteSession`/close lifecycle; nothing enters recently closed.
- There is no user-visible expired state; a temporary network disconnect reuses the existing reconnect UI and creates no replacement runtime.

## Remote and delivery boundaries

```text
desktop renderer / desktop Web
        |
        v
parent session attached host --createSelectionSideSession--> child runtime
        ^
        |
relay / desktop main only authenticate, schedule attachments and pass rpc-frame through
```

- Local and SSH/WSL/Docker all create the child along the parent session's shared-host attachment.
- The remote chain carries `workspaceIdentity` and `remoteSessionId` end to end; matching by `workspacePath` alone is forbidden.
- Desktop `desktop-continuous` stays direct continuous; Web remote `web-remote-replayable` keeps the snapshot/gap/owner/lease recovery boundary.
- The mobile viewport shows no entry and starts no separate runtime for this feature.

## Accepted cases and pruning

| ID | Setup / action | Expected evidence | Status |
| ----- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| SSC01 | First selection of ordinary single-line text opens the side pane | New hidden child + active tab + pending chip, no auto-send | accepted |
| SSC02 | Select again after typing a question in the active side tab | Reuse the active child, keep the draft and append the reference | accepted |
| SSC03 | Re-select an identical source and text | Activate the original tab, no duplicate chip | accepted |
| SSC04 | Select while the main session is generating normally | Creation allowed; copies the stable input boundary, excludes streaming output, sends follow queue/guide | accepted |
| SSC05 | Main session Permission/AskUser/ExitPlanMode | The whole selection overlay is not shown, restored once cleared | accepted |
| SSC06 | The side pane itself is blocked | Main-task actions usable; side-pane actions disabled, restored after handling | accepted |
| SSC07 | child sessionNotFound | No expired page; remove the old tab, this action creates a new child | accepted |
| SSC08 | Manual close / close others / all | Runtime closed, tab removed, not in recently closed | accepted |
| SSC09 | App restart | Tabs not restored; selecting again creates a new child | accepted |
| SSC10 | Switch main task and back | Hidden/restored per parent task, no session, workspace or draft mix-up | accepted |
| SSC11 | Cross-row, over limit, control text, mobile | No session created; over limit gives a localized hint | accepted |
| SSC12 | Remote same path, different identity | Exactly bound to the shared host, no remote mix-up, no separate runtime | accepted |
| SSC13 | Multi-turn tools and permission requests in the side pane | Execute normally and block interaction, but do not enter the task list | accepted |
| SSC14 | Add to current task and select consecutively | Main composer keeps the draft and accumulates chips; the new block persists only `{ text }`, the old block is readable | accepted |
| SSC15 | Main task enters later real user turns | The original side pane can keep taking input, no auto-expiry or rebuild | accepted |
| SSC16 | Side pane tries goal/edit/retry/fork | No UI entry; direct protocol calls rejected by the unified guard | accepted |
| SSC17 | Select completed/streaming assistant body | Both actions appear; reference frozen to the text at action time, contentType=assistant | accepted |
| SSC18 | Click "辅助对话" on the start page or top `+` | Both entries have consistent semantics; each creates and activates a new empty composer | accepted |
| SSC19 | child first opened or cold-restored after inheriting parent history | Provider keeps history; all UI timeline/search/page/count are empty | accepted |
| SSC20 | Click the fixed entry while the parent task is running/blocked | Entry still usable; absent with no active task and on mobile | accepted |
| SSC21 | Selection overlay shows Chinese/English actions | About 32px high, 12px font; Chinese uses "辅助对话" consistently | accepted |
| SSC22 | Fork to a child after the parent task has side chats | The child's expanded side bar shows the start page; switching back to the parent restores the same tab/child/draft | accepted |
| SSC23 | Goal parent task is active, paused or complete | All three create a child; provider body kept, Goal run state or identity not inherited | accepted |
| SSC24 | Within one assistant row, select from ordinary Markdown across into a table cell with an action toolbar | Overlay appears normally; the `select-none` toolbar button sitting inside the Range DOM does not turn the selection into a control selection | accepted |
| SSC25 | Click the fixed side chat entry repeatedly on the same parent task | Creates two tabs with different childSessionId, titled 辅助对话 1/2 | accepted |
| SSC26 | Same parent task has several side tabs, activate one, then select in the main timeline | The reference goes only into the active child, keeps its draft; sibling tabs get no new reference | accepted |
| SSC27 | Same parent task has a side tab, but the currently active tab is a browser/code non-side tab | Main-timeline selection creates and activates a new side child, no guessing of the most recently used tab | accepted |
| SSC28 | Type a bare `/side` or `/btw` in the main composer and select it from the `/` panel | The two commands show separately and behave equivalently: create and activate an empty side tab; the command token is removed from the input, no message sent; the commands are not written to the CLI catalog | accepted |
| SSC29 | Open the `/` panel in draft state (no session yet) or in the side chat's own composer | The panel contains no `/side`, `/btw`; the command list returned by the CLI is unaffected | accepted |
| SSC30 | Desktop main session idle, type `/side 你好` or `/btw 你好` in the main composer | Submit the text argument directly: creates and activates a new child; the child's first user input is `你好` and is sent at once; the parent timeline does not show `/side 你好` | accepted |
| SSC31 | Desktop main session running (may have an active turn/queue) | Submit `/btw 继续查一下`: the child's first message startNow; the parent active turn continues, parent queue/guide and workspace unchanged | accepted |
| SSC32 | Main composer carries an attachment, code comment, web/PPTX element or selection reference | Submit `/side 你好`: the App command is not consumed, no child created; sends via the main session's original input path | accepted |

Pruning: mobile only verifies the entry is absent and selection UI is not crossed with replayable physical recovery; theme/locale are covered by component and visual representatives; ordinary generation and queue/guide only verify the existing routing has not regressed; tool families are covered by a representative read-only tool, a file-write tool and one permission, not enumerating all tools; the same-path remote combines only with identity/attachment and does not spread to relay business state. SSC22 was confirmed on 2026-07-16 to keep only the desktop continuous side-chat representative path; other session-scoped tab types, remote/mobile, theme/locale are not crossed again. SSC23 enumerates only active (no verifier), paused (failed verifier) and complete (passed verifier); `budget_limited` is equivalent to paused as the "unfinished Goal snapshot" class and is not crossed again with client, provider or theme. SSC24 keeps only the "ordinary Markdown -> table cell" representative path within one assistant row; a reverse drag shares the same Range normalized by the browser, and streaming, theme, locale, remote/mobile are not crossed again. SSC25/26/27 cover only desktop continuous, a local workspace and two side tabs; remote identity stays with SSC12 and is not crossed with tab count, blocked type, theme/locale. SSC28/29 verify only App-layer injection, select-to-open and the draft-state/side-pane gate; the combination of `/side` with tab count and locale is covered by i18n keyword unit tests and not E2E-crossed. SSC30/31 keep only the idle/running representative states of text argument, desktop continuous and a local workspace; SSC32 is covered by focused composer/parser tests and not crossed with every structured context.

## E2E handoff

- SSC01/02/05/07/08/09/13/14/15/17/18/20/22/25/26/27/28/29/30/31 first enter conversation-session `manual-review/pending` with stable `E2E_SSC_*` markers.
- SSC03/04/06/10/11/12/16/19/21/23/24/32 rely mainly on component, protocol, service/core focused tests; SSC22 additionally uses a Side Pane visibility focused test for the shared render branch; the suggestion build, argument parsing and command idempotency details of SSC28/29/30/31 are covered by unit/protocol tests.
- The provider fixture uses case-local `fast-text`; SSC13 permission uses an existing interaction fixture, and SSC07 uses a deterministic sessionNotFound injection, not sleep simulation.
- After human confirmation: promote, fixture check, default replay and Docker admission.
