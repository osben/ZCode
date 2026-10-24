# AskUserQuestion five-minute auto-continue

## Goal

A normal `AskUserQuestion` must not block a running task indefinitely. Each normal question that reaches the head of the interaction queue gets a five-minute window owned by the CLI/runtime; if the user does not answer, the runtime resolves it successfully with empty answers and the model continues with best judgment. The sidebar only projects that authoritative state and never decides timeouts itself.

Normal permission requests and `ExitPlanMode` plan approval do not auto-resolve.

The user can turn off "提问自动继续" (ask auto-continue) in settings. The setting defaults to on for upgrade compatibility; when off, all currently pending normal `AskUserQuestion`s and questions registered while off wait for the user forever. Re-enabling affects only newly registered questions and must not restore old deadlines.

## Product timing

```text
0:00                    1:00                              5:00
 │──── silent wait 60s ─│──── visible progress pill 240s ─│
 │   static full label  │   fill's right edge shrinks left │
 │                      │                                  └─ answers: {}, continue
 └──── user's first meaningful action: permanently pause this auto-resolution ─┘
```

- `0..60s`: the sidebar shows a static full "等待确认" (waiting for confirmation) with no time remaining.
- `60..300s`: pill size and text position stay fixed; the blue accent fill shrinks linearly from 100% to 0%, left edge fixed, right edge receding.
- `240..300s`: the question panel's top-right additionally shows discrete seconds `59秒..1秒` (`59s..1s` in English); never `60` or `0`; clicking the seconds only pauses the timer.
- `>=300s`: the runtime submits `{ answers: {} }`; the tool result explicitly tells the model the user did not answer and to continue with best judgment.
- After the user's first meaningful action at any stage, the state becomes permanently `snoozed` and the pill returns to the static full style; this interaction never auto-resolves.

## User setting

- AppSettings field `askUserQuestionAutoResolutionEnabled`, default `true`; old settings files missing the field parse as on, with no migration.
- The settings page "交互" (interaction) group uses the "提问自动继续" switch. Turning it off persists AppSettings first, then notifies every window to push the preference to its connected local/remote hosts.
- Turning off must apply immediately to running main Agents, background tasks, Bots, and subagents; it must not wait for the next session creation or merely hide the UI animation.
- On turn-off, existing `hiddenGrace` / `visibleCountdown` become persistent `snoozed`; old questions not yet at the queue head are recorded as never eligible, and get no deadline even if the setting is re-enabled later.
- Re-enabling only changes eligibility of newly registered questions; questions the user manually paused, that were paused by the setting, or registered while off stay waiting forever.
- Rapid toggles apply serially in the actual order the hosts submit to the CLI; a late old request must not overwrite a newer value.

## State model

`PendingInteraction.autoResolution` is optional; absence means no timing.

```text
                      visibleAt
registered ──> hiddenGrace ─────────> visibleCountdown
                    │                         │
                    │ meaningful input /      │ meaningful input /
                    │ setting disabled        │ setting disabled
                    └──────────────┬──────────┘
                                   v
                                snoozed

visibleCountdown ── deadlineAt ──> resolved(answers: {})
any pending ── normal answer / stop / turn close ──> resolved / removed
setting disabled ──> current and during-off registered Asks permanently ineligible
setting re-enabled ──> only Asks registered afterwards may enter hiddenGrace
```

- `hiddenGrace`: `startedAt`, `visibleAt`, `deadlineAt`.
- `visibleCountdown`: the same three absolute times; the stage change is a recoverable event, not a UI-inferred business state.
- `snoozed`: `startedAt`, `snoozedAt`; no deadline.
- Production constants are fixed: `visibleAt = startedAt + 60_000`, `deadlineAt = startedAt + 300_000`. Tests shorten waits by injecting clock/scheduler; product values must not change.
- The Registry records timing eligibility per question at registration. A global setting-off revokes eligibility of all current questions; re-enabling must not backfill existing registrations.

Only the queue-head normal `AskUserQuestion` gets a `startedAt`; later pending interactions start their own full five minutes only after the previous one dequeues, so queue wait time never consumes their answering window.

## Authoritative path and recovery boundaries

```text
Settings Switch ──> AppSettings ──> cross-window broadcast
                                           │
                                           v
                                  each connected host service
                                           │ strict workspace protocol
                                           v
AskUserQuestion tool ───────────> CLI interaction coordinator
        │ requestUserInput                  │ timer / setting gate / snooze / resolve
        │                                   ├──────────────> tool result
        │                                   │
        │                                   └─ durable autoResolution event
        │                                                   │
        │                                                   v
        └──────────────────────────────────────────> product projection
                                                            │
                                                            ├─ task snapshot
                                                            └─ sessions-index summary
                                                                     │
                                                                     v
                         desktop-continuous live / web-remote-replayable snapshot+gap
                                                                     │
                                                                     v
                                              UI pending dialog + sidebar badge
```

- Deadline, user answer, and pause commands are handled first-come-first-served in the CLI command queue's actual processing order.
- Setting-off vs. deadline races also resolve by the CLI's actual processing order: if off applies first, keep the interaction pending and persist `snoozed`; if the deadline already resolved, a late setting sync must not produce a second tool result.
- Normal answer, stop, turn end, and interaction removal must clear the timer.
- After CLI/UI reconnect or process recovery, use the persisted absolute times; the latest stage is saved per interactionId as a `runtime/user_input_auto_resolution` session entry, overwriting earlier ones. If the deadline has passed at recovery, resolve immediately with empty answers.
- If the global setting is off at recovery, any persisted active deadline must first become `snoozed`; no auto-resolution inside the recovery window.
- `snoozeInteractionAutoResolution { interactionId }` is idempotent: repeated pauses, already resolved, or ineligible interactions all return noop.
- `workspace/updateInteractionPreferences` is the strict host → workspace CLI control-plane method. Its parameters carry the full workspace ref; the CLI ACKs only after persisting all affected interactions.
- `userInput.autoResolutionUpdated` is a recoverable event recording start, entering the visible stage, and pause; the snapshot is the current fact, events serve continuous increments and replayable gap recovery.
- `SessionSummary.pendingInteraction` carries only the lightweight `kind`, `toolName`, and auto-resolution state the sidebar needs, so background tasks can distinguish normal permissions, `AskUserQuestion`, and `ExitPlanMode` without opening details.

### Multi-client and identity isolation

- The desktop renderer keeps the `desktop-continuous` main path and never splices mobile replayable runtime messages.
- Mobile `/remote` attaches to the desktop's existing host; it starts no separate Agent runtime and never pushes timer state down to relay/main.
- Mobile recovers the same authoritative deadline or `snoozed` state from the `web-remote-replayable` snapshot/gap and must not restart its own five minutes. A deadline paused by setting-off during a mobile disconnect stays permanently waiting after reconnect.
- Interaction owner/lease, origin, `workspaceIdentity`, `workspacePath`, and `remoteSessionId` routing are unchanged; the identity key stays `workspaceIdentity?.trim() || workspacePath`.
- Background tasks, Bots, subagents, and normal tasks share one coordinator; a subagent origin is not lost by auto-resolution.
- Local Bots reuse the window host's Agent service; remote Bots hold an independent desktop-attached remote runtime RPC port. Setting sync must also push to these **already-cached** Bot runtimes and must never create a remote Host/Agent just to sync a preference. A newly created Bot runtime applies the latest preference before exposing task/session services.
- Setting sync does not fork by `clientMode`; it mutates the same authoritative registry of the shared-host runtime. Post-change interaction facts still reach desktop via `continuous` and mobile via `replayable`.

## Meaningful user actions

Each of these sends one pause command:

- mouse first enters the whole normal `AskUserQuestion` panel;
- clicking an option, or selecting one with the keyboard;
- typing or pasting custom input;
- forward/back question navigation;
- a Bot multi-question flow recording its first valid per-question answer;
- clicking the last-minute seconds in the panel's top-right;
- clicking the sidebar AskUserQuestion "停止计时" (stop timer) pill.

Opening a task, programmatic focus, scrolling, or window re-visibility are not meaningful actions. Hovering the sidebar pill only swaps "等待确认" for "停止计时" and sends nothing; clicking the pill sends the pause. Mouse entering the question panel is clear read/answer intent and pauses immediately. The UI sends only the first pause; the runtime stays idempotent against reconnect or multi-client races.

## Last-minute hint in the question panel

- Only a normal `AskUserQuestion` still carrying `deadlineAt` shows seconds when the remaining time is strictly under 60; `snoozed`, normal permissions, and `ExitPlanMode` never do.
- Seconds derive from the absolute `deadlineAt`: one timeout waits to enter the last minute, then only the single currently open panel calibrates per second; sidebar task rows get no new JS interval.
- Clicking the seconds sends only the pause command — it selects no option and submits no empty answer. Once the authoritative projection is `snoozed`, the seconds disappear and the sidebar returns to the static blue "等待确认".
- Mobile has no hover; pause still triggers by option click, input, navigation, or clicking the seconds. Desktop continuous and web remote replayable recover the same absolute deadline.

## Local question-progress boundary

The CLI/runtime owns interaction lifecycle and auto-resolution state; the current question, focus, and uncommitted answer drafts in a mounted renderer are local form state. The boundary between them is `interactionId/requestId`; never treat a changed snapshot object reference as a new question.

```text
same requestId
hiddenGrace ── first meaningful action ──> snoozed
     │                              │
     └──── CLI projection updates metadata ───┘
                                    │
                                    └─ UI keeps questionIndex / drafts / focus

new requestId ──> new question instance ──> init from currentQuestionIndex / answerDrafts
```

- For the same `requestId`, snapshot updates to `autoResolution`, owner/lease, origin, or other non-question lifecycle fields must not reset the current tab, selected answers, custom input, or the first-action flag.
- During task switching, if `sessionId` has changed but the previous task's snapshot has not been replaced, that old snapshot must not render the current task's question or participate in its draft cleanup; only a projection with `snapshot.sessionId === sessionId` is authoritative for the pending interaction.
- A new `requestId` must create a new local question instance and must not inherit the previous drafts.
- On first open, reconnect, or replayable snapshot remount, initialize from the request's `currentQuestionIndex` / `answerDrafts`; plain metadata updates after mount never overwrite local edit progress.
- Desktop and mobile each keep uncommitted renderer-local drafts per `workspaceKey + taskId + requestId`; after a task switch unmounts the question component, returning to the task must restore the current question and entered answers. Final `resolveInteraction` stays first-come-first-served at the runtime; a successful resolve clears the matching local draft. Cross-client realtime draft sync would need a new explicit protocol state — never implicit sync via object rebuilds.

## Tool and history semantics

- A successful `AskUserQuestion` output may have `answers` as an empty object.
- An empty answer is not a user rejection: it selects no default option and produces no permission deny.
- The model-visible tool result explicitly says the user did not answer and to continue with best judgment.
- The UI history shows "未回答，已自动继续" (unanswered, auto-continued) and never fabricates a user message.
- Normal answers, explicit rejection, normal permissions, and `ExitPlanMode` keep their existing semantics.

## Sidebar display

- Normal permissions, `ExitPlanMode`, and other non-Ask blocking interactions: static green "等待确认", no animation, no "停止计时" action.
- Ask `hiddenGrace` / `snoozed`: a distinct light-blue surface with dark-blue text, static full "等待确认". `hiddenGrace` still has a deadline: hover shows a gray "停止计时" that can be clicked to pause; `snoozed` keeps the blue "等待确认" and is no longer clickable.
- Ask `visibleCountdown`: fixed blue track with an inner blue fill; default text centered "等待确认"; on hover/focus-visible the fill hides and it switches in place to gray "停止计时" without changing pill width; clicking sends the existing idempotent pause command.
- Do not reuse `brand` (black/white under the Zai theme) or borrow `success` for a waiting state; Ask and normal confirmation each use stable interaction semantic tokens.
- Normal task rows, timeline rows, and grouped task rows reuse one badge component.
- Recover progress from absolute times and CSS `transform: scaleX(...)`/animation; no high-frequency JS interval per task.
- Under `prefers-reduced-motion`, continuous animation is disabled; refresh the ratio from absolute times only on protocol state, focus, or visibility changes.
- Desktop and mobile widths, light/dark themes, and Chinese/English use the same semantic tokens and i18n keys.

## Acceptance and pruning

Must cover:

- fake-clock stages 0s, 59s, 60s, 180s, last-minute `59秒..1秒`, 300s, and empty-answer resolution;
- pause during silent/visible stages, repeated pause noop, cleanup on normal answer/stop/turn close;
- panel mouseenter, top-right seconds click, programmatic focus not pausing, sidebar hover not pausing;
- multiple pending interactions each getting a full window serially;
- sessions-index background summary and desktop continuous / web replayable recovery;
- the three sidebar row kinds, both themes, Chinese/English, desktop/mobile layouts;
- default on, registered before off, off during timing, registered while off, and re-enable without retroactive deadlines;
- Q09–Q14, Q23–Q25 conversation cases.

Explicit pruning:

- No countdown cross-product with permissions and `ExitPlanMode`: they have no `autoResolution` in the protocol.
- No timing cross-product over every option count, question count, and input method; the first-meaningful-action boundary covers it.
- No real five-minute waits; automation injects clock/scheduler, and production constants get separate static assertions.
- relay/main stores no business timer; recovery verifies only shared-host runtime snapshot/gap.
- Main Agent, background tasks, Bots, and subagents do not each duplicate full GUI E2E; the shared registry is covered by fake-clock/protocol tests, desktop GUI keeps one representative path, and mobile replayable is covered by recovery integration tests.

GUI candidate: `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-ask-user-question-auto-resolution-setting.test.ts`.
It may use `ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE=20` only under `ZCODE_ENV=test` to scale the runtime's 60s/300s windows; production ignores the injection. The candidate does not promote to formal E2E before manual confirmation.
