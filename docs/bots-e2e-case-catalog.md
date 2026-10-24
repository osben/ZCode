# Bots E2E Case Catalog

## Topic collaboration additions

- BOT-E2E-TP-01 (also covers mention-only guidance without admission and quoted text in one CLI queue input): a native-topic-bound task uses the real Host/CLI queue; Desktop source and attachments survive cancellation; resolving its saved delivery through the reply action bar targets that topic and works at narrow viewport widths.
- BOT-E2E-TP-02: two ordinary topics and a dedicated topic-group root create distinct tasks; ordinary discussion is silent; the next mention sees only the incremental background up to its own message. Requires real Feishu CUA evidence in addition to provider/service tests. No fixture can prove tenant permissions or native routing.

This document records the Bot channel end-to-end behavior contract. Bot cases are independent of conversation-session: they reuse the ZCode task stream, but the entry, state owner, and external evidence live in `BotsService` and the provider APIs.

## Scope decisions

| Boundary | Decision | Reason |
| --- | --- | --- |
| Main scope of the original round | Feishu/Lark `streaming_card` full lifecycle | the most user-visible, cross-layer-risky behavior in the branch |
| Provider environment | CI uses a mock Feishu HTTP API | avoids real tenant, credential, and network flakiness |
| Task timing | `controlled-stream` | running expansion and terminal collapse must be observable; `fast-text` cannot prove intermediate states |
| Client semantics | `bot-channel-continuous` | the Bot stream never enters mobile `web-remote-replayable` recovery semantics |
| Multi-host runtime lock | later separate process E2E | service-integration regression already exists; multi-process fixtures are not mixed with card semantics |
| Plan approval UI | excluded | no direct state crossing with Bot channel lifecycle |

## Accepted cases

### BOT-E2E-MN-03: name mention without native id

- Setup: authorized group/topic, member directory, and trusted bot mention from history; the input contains a text name only.
- Action: ReplyToChannel queries by name containment; a unique candidate or unique full match sends directly; multiple people resolve individually.
- Assert: English names keep spaces; all unresolved names return at once; an un-queried result is never reported as success.
- Assert: a unique target becomes a native at; ambiguous/no-result/no-permission sends nothing; one toolCall delivers at most once.
- Evidence: MN-01 service/platform E2E covers both channels and group/topic; MN-02 real CLI follow-up resolves group members by name.
- Status: formal; `bots/feishu-channel-mention.test.ts`, promoted after user confirmation on 2026-10-08. Real tenant permissions and mobile UI remain unverified; platform doubles are not production proof.

### BOT-E2E-SR87: draft valid selection and first dispatch

- Setup: a bound bot saves a personal-plan model/high; the target-selection service returns a Team valid selection of the same model/high.
- Action: view `/model` and `/think`, then send the first plain message; separately attempt to change level and dispatch with an invalid result.
- Assert: menus show valid identity and level but do not change the draft; the first task uses the valid selection; the invalid original intent is not replaced by a default model and creates no task.
- Evidence: controlled selection and task service calls, bot state writes. The shared parsing algorithm is covered by provider integration tests; no claim that this case sent real model requests.
- Status: manual-review pending; scope per Todo87; no external Feishu network involved.

### BOT-E2E-SR99: follow-up selection of a bound session

- Setup: the bot has bound an idle session; the session's original selection is a personal-plan model/high, the shared view returns the Team same model/high or unavailable; the bot stores no second selection after binding.
- Action: the next plain message arrives from the bot.
- Assert: only the session's original selection queries the shared view; when available, the full valid selection goes into the real send parameters; when unavailable, nothing is sent, no default replacement, no rewriting of the original selection or bot draft.
- Evidence: a synthetic harness proves the bot consumption boundary; W99-E03/E06 passed in Pro through the production task adapter, real stdio worker requests, and cold recovery. The IM API remains an isolated double — no claim of a real Feishu tenant; see the Todo99 review ledger.
- Status: accepted, manual-review pending. `/model` is adjudicated to modify/save the same session immediately; the full chain contract is W99-E06.

### BOT-E2E-SC-01 Feishu single-card timeline lifecycle

- Setup: a bound Feishu private-chat bot, `replyMode=streaming_card`, zh-CN locale; the mock provider returns fixed tokens, message id, and reaction id.
- Action: a Feishu callback submits a plain message tagged `E2E_BOT_STREAMING_CARD_LIFECYCLE`; the task produces text, tool start/finish, text, tool start/finish, final text, and `task_complete` in order.
- Assert:
  - the callback enters the shared business pipeline and creates one task;
  - the provider creates exactly one Card JSON 2.0 and only PATCHes the same message id afterwards;
  - the timeline is strictly `message → tools → message → tools → message → terminal status`;
  - the newest running tool block expands; all tool blocks collapse at the terminal state;
  - tools show a compact summary only; the summary formatter may extract safe path/command hints but never expands the full input object or leaks output, stdout, stderr, or raw JSON markers;
  - the typing reaction is set while running and removed after the terminal event;
  - the subscription uses `bot-channel-continuous` and never requests replayable snapshot/gap recovery.
- Evidence: task service calls, stream subscription parameters, the Feishu mock HTTP request sequence, and the final Card JSON.
- Fixture: `packages/desktop/test/e2e/fixtures/bots/feishu-streaming-card-lifecycle.json`.
- Status: `formal`.

## Accepted and automated supplementary cases

| Case ID | Candidate | Status | Reason |
| --- | --- | --- | --- |
| BOT-E2E-AQ-01 | AskUserQuestion multi-choice/custom updates on the same card | formal | controlled elicitation + callback fixture |
| BOT-E2E-IL-01 | blocking interaction cuts the streaming card and keeps the final interaction card | formal | controlled stream + Feishu HTTP request sequence |
| BOT-E2E-RT-01 | two local hosts contend for the same Feishu runtime lock | formal | real file-lock owner/contender/takeover evidence |
| BOT-E2E-RT-02 | attached remote host starts no provider runtime | formal | startup state and zero provider network requests |
| BOT-E2E-PV-01 | Feishu/Lark domain isolation | formal | full origin assertions on one HTTP mock |
| BOT-E2E-RW-01 | disconnected remote workspace neither reconnects nor falls back locally | formal | remote service call counts and zero task calls |
| BOT-E2E-CR-01 | bot-created automation pushes results back to the origin session | formal | Host injection, persisted reopen, subscribe-before-dispatch, provider outbound |
| BOT-E2E-CF-01 | bound Feishu long-connection failure shows a diagnosable status | formal | real desktop UI + runtime state + binding joint evidence |

## Pruning

| Decision | Combination | Class | Basis |
| --- | --- | --- | --- |
| BOT-PRUNE-01 | streaming card × Telegram/Weixin | pruned | `streaming_card` is a Feishu/Lark provider capability; other providers keep their reply semantics |
| BOT-PRUNE-02 | streaming card × mobile replayable recovery | pruned | the Bot task stream is fixed to `bot-channel-continuous` |
| BOT-PRUNE-03 | single-card rendering × multi-host runtime lock | pruned | different state owners and failure evidence; merging weakens failure localization |
| BOT-PRUNE-04 | Bot lifecycle × plan approval dialog rendering | ignored | adjacent commit in the branch, not part of the Bot provider delivery contract |
| BOT-PRUNE-05 | automation push-back × intermediate streaming messages | pruned | automations push only `summary_changes` terminal state, avoiding chat spam from tool progress |
| BOT-PRUNE-06 | automation push-back × mobile replayable recovery | pruned | push-back keeps `bot-channel-continuous`, never entering mobile gap/snapshot recovery |
| BOT-PRUNE-07 | connection-failure UI × Desktop re-coverage of unbound bots | pruned | the unbound branch has component contracts already; Desktop E2E focuses on the conflict state where binding and runtime error coexist |

### BOT-E2E-CF-01 bound Feishu long-connection failure status

The case loads from the case-local `bot-config.v3.json`; after enabling through the real UI it checks the v3 write and retained bindings. One-shot import of the old file, the old strict reader, and rollback bytes are verified by `botsStorageV3.test.ts`.

- Setup: in the isolated Desktop E2E config, a Feishu bot with an existing `providerUserId` but no credential, so the provider runtime deterministically errors; no real Feishu network.
- Action: open the real Desktop dialog from "Mobile remote control → Bot management", enable the bot, wait for the runtime refresh, and reopen the dialog.
- Assert: the left summary shows Feishu connection failure; the right status shows “连接中断” (connection interrupted) rather than “已连通” (connected); the error detail suggests long-connection limits or Feishu being busy, recommends binding a new bot on persistent failure, and keeps the unbind entry.
- Evidence: bot config under isolated HOME, real Host runtime status, desktop renderer DOM, and failure screenshot.
- Boundary: verifies only the Desktop `desktop-continuous` management view's runtime projection; creates no mobile `web-remote-replayable` session and needs no real Feishu WebSocket.
- Status: `formal`, promoted after Desktop manual acceptance.

### BOT-E2E-CR-01 bot-origin automation terminal push-back

- Setup: a bound Feishu private-chat bot; send a message triggering `CronCreate` in a real workspace; the mock Feishu provider records all outbound requests. Weixin reuses the same delivery-target/watcher contract, proven separately by a provider service integration test for `/sendmessage` terminal outbound.
- Action: create an automation, close and reopen the automation repository to prove the target persisted; the scheduler restores the bound task, registers the bot watcher, then sends one controlled automation prompt, injecting `task_complete` and `task_error` separately.
- Assert:
  - the Bot prompt turn carries the Host-injected `{ provider, botId, providerUserId, chatType }`; normal UI prompts carry none;
  - `CronCreate` parameters expose no bot target; the automation protocol reads and persists it only from the active turn;
  - after repository reopen, the target is still readable by `automationId + workspaceKey`; dirty JSON degrades to no target;
  - the scheduler completes the `bot-channel-continuous` subscription before `sendPrompt`;
  - completion sends only the final result and change summary to the original session; error sends one failure message;
  - bot deletion, disabling, provider mismatch, or provider outbound failure only logs a warning, never changing the automation run's dispatch or settlement;
  - `workspaceIdentity` flows through remote workspaces; matching by `workspacePath` alone is forbidden.
- Evidence: the formal Desktop E2E proves V4/legacy protocol payloads, sqlite reopen reads, task service call order, stream subscription parameters, and mock Feishu provider HTTP; Weixin `/sendmessage` is proven by the provider service integration test in `packages/services/test/botsService.messageFlow.test.ts`.
- Boundary: bot push-back creates no separate runtime; desktop stays `desktop-continuous`, mobile remote stays `web-remote-replayable`.
- Status: `formal`.

### BOT-E2E-IL-01 Feishu/Lark interaction and streaming-card segmentation lifecycle

- Setup: Feishu/Lark private-chat bot, `replyMode=streaming_card`; the task first produces normal agent text, then an AskUserQuestion or plan approval.
- Action: the user advances and completes the interaction, the agent continues output; also cover task error/stop while an interaction waits.
- Assertions: the old streaming card keeps only the pre-interaction agent content and seals into a no-Running state; an in-progress AskUserQuestion accumulates as “submitted answers → divider → current question”, and current-question drafts never enter the answered area; the WebSocket action handler must synchronously produce the single `card.raw` from the business callback's complete outbound (including the new-question token) and never run `card_update_token`, message PATCH, POST, or DELETE; after completion, cancellation, or task termination the interaction card stays as a read-only card with no buttons; post-interaction agent content opens a new streaming card; no question, answer, or plan body is backfilled into old or new streaming cards.
- Evidence: Feishu message POST/PATCH/DELETE order, Card JSON 2.0 payloads, message-id segmentation, and task stream events.
- Boundary: the bot stays on `bot-channel-continuous`; no extension into desktop `desktop-continuous` or mobile `web-remote-replayable` session recovery.

## BOT-E2E-DT-01 deleted-task auto-recreate (ZCT-2096089929570893824)

- Status: pending; spec `packages/desktop/test/e2e/bots/manual-review/pending/bot-deleted-task-recovery.test.ts`.
- Setup: a bound Feishu bot pointing at an old task in a delete tombstone, with old interaction state kept; the mock provider records notification requests.
- Action: a plain message enters the provider callback, then the same message id is redelivered.
- Assert: the old task is not restored; exactly one new task is created and bound in the same workspace; old interactions are cleaned; one notice explains deleted → recreated → no context inheritance; the original message dispatches exactly once; the Desktop created broadcast points at the new task; the subscription stays bot-channel-continuous.
- Fixture: case-local synthetic metadata; deletion state and provider HTTP come from deterministic fixtures; no user bot accessed.
- Unit boundary: local/remote identity, not-deleted-but-hidden-from-list (archived/pinned), index read failure, create failure, notification failure, zh-CN/en-US. Archive-only behavior is unchanged.

### BOT-E2E-DF-01 Feishu reply delivery failure and recovery

- Status: pending. Spec: `packages/desktop/test/e2e/bots/manual-review/pending/feishu-delivery-error.test.ts`.
- Setup: bound private Feishu bot; synthetic HTTP business failure with code/msg/log_id.
- Action: a private command reply fails, then a later reply succeeds; group input is rejected.
- Assert: status exposes deliveryError without misreporting a WebSocket failure; the error clears after a successful delivery; private outbound uses open_id; group creates no task.
- Evidence: service/provider HTTP and status projection; UI rendering is separately unit-tested. No claim of live Feishu tenant reproduction, mobile device validation, or DOM end-to-end coverage.

DF-01 verification (2026-09-07): macOS Desktop WDIO passed (`desktop-e2e-20260907040958265-p60496-c535b8967f7e59a1`). HTTP 200/400 business failures, body/header log ID, update rejection, streaming circuit status, and localized error rendering are covered by 124 passing unit tests. Typecheck, Desktop E2E typecheck, and lint passed (43 warnings, 0 errors). The pending case is not promoted. Live Feishu, Windows/Linux, mobile devices, and delivery-failure DOM interaction remain unverified; the existing connection-error DOM regression CF-01 passed in macOS Desktop WDIO.

## BOT-E2E-RW-02: R3 stable / legacy bot identity

- accepted: the Source has handshaked and the current-window remote session is online while the fallback snapshot is still legacy; request model/task entries with stable and legacy bot contexts respectively.
- Assert: both entries normalize to the same stable scope; no false disconnect, no local task calls, no extra Host/Agent; an authorized old identity, after upgrade, is still limited to the same Source.
- Contrasts: same path different Source, rebinding the old route, preferred Profile differing from the online route, disconnect/reconnect generation change, concurrent task/model lookup, late port and dispose.
- Primary evidence is a real-module chain probe and Bot service synthetic E2E; no claim that real Feishu/Telegram delivery was verified.

## Feishu group collaboration (accepted, pending automation)

- BOT-E2E-GR-01: two enabled groups and private chat retain separate task/configuration; member commands cannot switch tasks or approve. Group prompts carry trusted source to canonical admission; no legacy sendPrompt.
- BOT-E2E-GR-02: owner/member inputs queue during execution; cancellation affects the CLI item only; busy task switching reports running/queue/interaction reasons. After Desktop stop, stale Bot approval records do not block a new draft. Desktop and mobile show source/attachments from the same canonical rows and queue.
- BOT-E2E-GR-03: final summaries persist per delivery segment; unknown outcomes are not replayed; disabled/switched groups reject saved-result resend. No tool or streaming output enters the group.
- BOT-E2E-GR-04: completed reply action bar shows compact recovery only for its own unresolved deliveries; clicking opens actions without repeating the result body, and resolving hides the icon; no persistent group-sync/shared-workspace banner. Saved-result retry never resubmits a prompt. Source labels support zh-CN/en-US and narrow layouts.
- BOT-E2E-GR-05: CLI-confirmed queue admission shows OneSecond, start replaces it with OnIt, completion/error replaces it with CheckMark/CrossMark, and cancellation/stop removes it. Late admission cannot overwrite terminal state; other members' reactions remain. Queue cards have one localized waiting/cancel row. Provider payload/service transition assertions and actual Feishu visual evidence must be reported separately.

GR-05 queue-card correction: persist the card's message ID and follow the input through running and terminal states on the same card, removing cancel controls after queue admission ends. Verify normal queue promotion to completion, delayed card creation after completion, duplicate/late events, persisted target reuse and revoked-group no-op. Live acceptance must let the second input execute normally; cancelling the second input alone does not cover this regression.

These cases implement the accepted `bots-feishu-group-collaboration.md` contract. Synthetic provider HTTP and controlled task events are permitted for deterministic service integration evidence. Real CLI admission and renderer DOM assertions must be reported separately; mock task methods are not evidence of CommandInbox behavior. Real Feishu tenant permissions, mentions, attachment references, removal, and message restrictions require a real test group.

Group member display revision: GR-02/04 also checks the queue sender's name and click-to-view full identifier. Provider tests cover paginated directories and Feishu/Lark domains; UI tests cover historical name overlays and group isolation. Live tenant permission and actual member-name rendering require separate evidence.

### BOT-UI-TP-PREPARATION: preparation-state message bubble

- Setup: the real preparation component and the shared formal bubble, covering normal body, very long text, empty body, waiting-to-stop, and failure.
- Action: switch zh/en, dark/light, desktop/mobile widths; switch a prepared input to failure; publish the formal message first, then clear the preparation state.
- Assert: the prepared message belongs to the ConversationTurnGroup; the source row shows channel, name, and loading, hover/focus tooltip shows preparation state, and the bubble keeps only the body; it reuses the formal collapse/expand with no empty bubble or horizontal overflow; the failed temporary row is removed whole — no error, retry, orphan source, or empty turn; when the same-ID formal message arrives the preparation state hides while other inputs remain.
- Status: browser component candidate; does not represent real Desktop, mobile replayable, or Feishu platform E2E.

### BOT-E2E-PS-01 private-chat cross-input continuous delivery

- Setup: isolated Feishu, Telegram, and Weixin provider HTTP; persistent task binding and bot-channel-continuous service subscription.
- Action: the same task receives IM, desktop, and mobile turns in sequence, runs to completion, then runs again; inject late output after disabling.
- Assert: one reply per turn; the Feishu card never overwrites the previous turn; the subscription persists after the terminal state; no outbound after disabling.
- Evidence: the controlled-stream service → provider HTTP Desktop runner case; the synthetic inputOrigin is not evidence of real mobile/CLI input.
- Status: pending, `bots/manual-review/pending/bot-private-task-sync.test.ts`.

### BOT-E2E-MN-01 native channel mention reply

- Status: formal; `bots/feishu-channel-mention.test.ts`, promoted after user confirmation on 2026-10-08.
- Setup: an enabled Feishu/Lark group; deterministic native target nodes and task admission.
- Action: explicitly extra-reply quoting that input's refId, repeat the same toolCallId, then request an unknown ref.
- Assert: same group/topic native quote + body at; stable receipt with no extra HTTP on repeated calls; no send for unknown targets.
- Evidence: service → durable delivery → provider HTTP; not a claim that the model chose the tool itself or that a real Feishu client notified.

BOT-UI-MN: the real formal bubble, preparation bubble, and queue component show a channel chip at 390/1200px, dark/light; plain @ text has no channel node, no horizontal overflow, no platform id. Component browser tests are not equivalent to real-device mobile replayable verification.

## Branch acceptance completion (2026-09-23, accepted)

Scope: the Feishu group-collaboration branch's group chat, topics, materials, delivery, settings UI, and channel tools relative to staging. The user confirmed the full coverage completion; duplicate success receipts stay as-is with no dedup assertions added. State owners: the CLI CommandInbox owns admission/execution, the Bot Host owns binding, materials, and delivery, the UI only projects; no extra queue is created.

| Case | Setup → Action → Assert | Evidence and status |
| --- | --- | --- |
| BOT-E2E-TP-04 | real CLI topic running → bot receives a new message → auto-stops the old run, resumes after the authoritative terminal state, zero queueing, old output never impersonates the new turn | Host/CLI/model HTTP, pending |
| BOT-E2E-TP-05 | received history-file index → real ReadSessionContext → Host validates and downloads, CLI gets the right file; other tasks/revoked authorization download nothing | Host/CLI/mock platform HTTP, pending |
| BOT-E2E-FN-01 | terminal contains the full body after tool output → adapter reconciliation → the full result is delivered exactly once; normal conversation still works | adapter/real stream/platform outbound, pending |
| BOT-E2E-MN-02 | real CLI triggers ReplyToChannel → native mention succeeds → client follow-up queries new targets by name, no botGroupSource, no default approval popup | Host/CLI/mock platform HTTP, pending |
| BOT-E2E-GR-02 | group input during a run → cancel and normal promotion separately → FIFO, original source, same-card terminal, no duplicate input | adjusts the existing runtime case |
| BOT-E2E-GR-UI-01 | two bots/two groups → settings toggles, failure and recovery → isolation, persistence, no re-delivery | new UI candidate |
| BOT-E2E-PS-01 | private-chat bound task → IM/desktop/mobile consecutive turns and restart → one delivery per turn, explicit failure retry | extends the existing candidate; simulated origin is not mobile UI |
| BOT-E2E-MN-01/TP-03 | group/topic and multiple identities → reply and admin actions → quote, conditional @, admin reminder, idempotence | extends the existing service candidates |

Pruning: Feishu/Lark platform differences are covered by dual-platform service candidates; the real CLI main chain prefers Feishu; not every platform × theme is mechanically crossed. Theme/width is verified by component browsers; real mobile replayable, SSH identity, and platform tenant notifications are recorded separately — never replaced by narrow screens or stubs. New cases from the initial verification stage stayed manual-review/pending; after the 2026-09-23 user confirmation, the four new specs below were promoted, not into Docker/CI. Case-local fixtures and the canonical manifest come first, then controlled replays; all platform requests are isolated and no user bot is used.

Formal cases added that round (2026-09-23 user confirmation):

- `conversation-session/conversation-session-bot-channel-worker.test.ts`: MN-02 + FN-01 — real CLI native mention, source-less client follow-up, terminal completion after lost text deltas.
- `conversation-session/conversation-session-bot-topic-worker.test.ts`: TP-04 + TP-05 — running auto-stop resume and managed-attachment byte validation on tool results.
- `conversation-session/conversation-session-bot-continuous-worker.test.ts`: GR-02 normal promotion + PS-01 IM/desktop continuous subscription.
- `bots/feishu-bound-groups-ui.test.ts`: GR-UI-01 real Desktop RPC/persistence and group/bot isolation.

Paths are relative to `packages/desktop/test/e2e/`. The new worker formal cases use the real CLI/production Host services with isolated bot-repo and platform HTTP fixtures — not Electron UI or real-tenant verification. PS-01's restart, failure retry, and rebinding stay covered by `botsService.privateSync.test.ts`; mobile source simulation never upgrades to real-device proof. GR-UI-01's failure/concurrency/late callbacks and disabled bots stay covered by `botBoundGroupsInteraction.test.ts`; that round's Desktop case proves only the real successful save path. MN-01 adds same-task desktop follow-up and cross-task rejection; TP-03 extends Feishu/Lark × conditional @ over four scenarios — current-message quote, approval admin reminder, and ordinary Q&A conditional reminder; model inheritance stays verified by `botsService.groups.test.ts`.

### BOT-E2E-TP-06: other bots' topic input

- Setup: a human has joined the topic and started a controlled streaming task.
- Action: resolve another bot's topic message through the real Provider, then send the current bot's own message.
- Assert: the other bot's message stops the old run, then submits to the same task and replies; the bot's own message produces no input.
- Evidence: reuses TP-04's real Host/CLI, controlled model, and platform doubles; native push and real tenant permissions await manual verification.
- Status: accepted; implementation and regression evidence in the coverage matrix.

Bot receive-event regression: a real event with sender_type=bot maps to the internal app identity; an enabled normal group's native @ submits, disabled/no-@ does not; topic continuation keeps the active check, dedup, own-echo, and control-command isolation. TP-04 routes a bot event through Provider → Host → CLI → platform reply; the history API keeps using the app identity.
