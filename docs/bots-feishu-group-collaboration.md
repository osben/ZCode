# Feishu group collaboration

The new implementation of topic input materials follows [topic input materials](bots-topic-input-materials.md); the body-concatenation quotes and bot_topic_context auto-injection in the historical records below are replaced by standard quotes and text attachments.

## Identity and activation

One enabled group has one default conversation, plus independent topic conversations. The default key remains `(botId, chatId)` for backwards compatibility; topics use `(botId, chatId, threadId)`. Each conversation has one current task. `sender.open_id` is the actor, never the conversation identity. Card callbacks use `context.open_chat_id`. Different groups and private chats have independent task, workspace, model, pending interaction and history state. Shared workspace files are not isolated: activation discloses that concurrent groups can edit the same files. No automatic worktree is created.

Only the privately bound owner can `/enable` a group. Initial activation copies the private workspace/model/thought level into a new draft, but not its task, conversation or automatic permission grants. Missing workspace rejects activation. Repeated activation is idempotent. `/disable` stops intake, callbacks and delivery, without cancelling accepted work. Re-enable preserves context, not missed output. Removal from the group, unbinding or owner replacement revokes group access; joining again requires explicit owner activation. Both ordinary Feishu/Lark groups and dedicated topic groups are supported. Other providers are excluded.

## Topic collaboration (implementation contract)

This section is the current implementation contract for topic behavior, replacing the old per-@ flow, default-task alias, queue, and Steer paths. The default group conversation and private chats keep their semantics.

### Access, isolation, and exit

A topic is joined after a human's first @ of the current bot on their root message; a topic created by a user replying to the current bot's main-chat message joins automatically. The real sender, chat, and native thread id must be verified — never infer bot identity from display names or body text. A joined topic receives all subsequent human messages; plain discussion in un-joined topics does not execute. A joined topic also receives other bots' native messages, triggering the same handling, running-interrupt resume, and reply; the current bot's own messages are excluded by native open_id, never by name equality. Other bots cannot first-join or reactivate an exited topic; an enabled normal group's main chat is received only on a native @ of the current bot.

Receive events with sender_type bot (compat with old app tests/history input) are mapped by the Provider to the internal app identity. The history API's app and the receive event's bot must not be confused. Bot events without thread_id in dedicated topic groups still do not join. The app needs im:message.group_at_msg.include_bot:readonly to receive bot @, or im:message.group_msg.include_bot:read to receive group messages including bots, published and in effect; plain im:message.group_msg does not prove bot-message push permission.

Bot bodies (including slash commands and approval text) are plain input only and can never execute control commands or submit interaction responses. Message-id dedup, authorization revocation, and the stop barrier reuse existing flows — no second queue. History keeps human and bot messages (with native senderType); history content still triggers no separate execution. Status callbacks are not plain input.

Per `(botId, chatId, threadId)` (main chat counted separately), at most 5 consecutive other-bot messages are received; from the 6th they are silently ignored — no stopping the current run, no material prep, no CLI submit. A new human message through the existing access gate resets the counter; card/status callbacks never reset it. Duplicate messages (including old human messages) neither consume nor reset the count. The Bot Host persists the counter and received message ids within the existing serial state write, before entering the stop/prep flow; concurrent callbacks, late state writes, and restarts cannot bypass the cap. A received-but-failed preparation still consumes one slot, so failure redelivery cannot retrigger. Old v3 state without the fields starts from zero.

```text
human first join -> active topic
other bot native message -> Provider excludes self -> check active -> dedup/persist consecutive count (max 5) -> existing stop/material prep -> CLI admission -> reply
current bot native message -> discard
bot message in inactive / left topic -> discard (even with @)
```

Acceptance: another bot's message in Feishu/Lark submits and replies in the original topic; duplicate callbacks process once; own messages, un-joined topics, and post-exit bot messages are silently ignored; bot `/stop`, `/reconnect`, and approval text execute no control actions; history bot bodies and authorized attachments are readable. Only messages the platform actually pushes are processed, subject to app permissions and platform event scope; synthetic event tests do not prove real tenant push capability.

Each `(botId, chatId, threadId)` binds an independent task, including topics formed by bot replies. First trigger freezes the boundary, reads history, and prepares required materials; only on success are task creation and submission done. It inherits the group config snapshot, not other tasks' context or approvals; the same workspace still shares files, no automatic worktree. Concurrent messages during joining must not lose or duplicate task creation. Unknown topic identity is rejected, never falling back to main chat.

`/stop` stops the current run and cancels unsubmitted input, keeping the join; the bound user's `/leave` stops and exits. @ again restores the original task and backfills history. `/history off` pauses the topic; missing history permission blocks joining, with the app permission link and publish note. Group disable/unbind/leaving revokes joining, cards, and delivery authorization.

### Stop-and-resume

```text
inactive --first trigger--> preparing initial materials --success--> active/idle
active/idle --message prepared--> running(runId)
running --new human or other-bot message--> stopping(runId) + preparing pending messages
stopping --stop confirmed AND all materials ready--> running(nextRunId)
active --/leave--> inactive (task kept)
```

A new message requests a stop immediately; material preparation may run in parallel. The stop request binds the old run via the existing protocol expectedForegroundExecutionId (from activeWorks) — never the log traceId as execution identity; the next round submits only after the authoritative terminal state. All messages during stopping merge in join order, each original preserved; one run stops only once. Natural-completion vs stop races advance exactly once; late notifications do not affect the new round. Completed tool side effects are not rolled back — no promise of forced tool preemption.

Batching stores each message's messageId, senderId, senderName, body, quotes, and flat attachment indexes in the existing botGroupSource.messages; the last message is the intake boundary; message ids never repeat. The UI renders these structured originals one by one and never parses concatenated bodies.

The preparation cache holds unaccepted input only; the CLI CommandInbox stays the single accepted queue. The Bot layer must not build an accepted queue. Submissions use stable commandIds; on confirmation loss, query the original command — never execute twice. The Host records a task- and remoteSessionId-isolated cancellation generation before cold recovery/attachment upload and revalidates after upload; /stop and /leave increment the generation, blocking late intake of old input. This generation stores no accepted input.

Cancellation and command sends share a task/workspace/remoteSessionId-level serial barrier. When a send acquires the barrier, it rechecks the preparation generation; a cancel immediately invalidates not-yet-sent old generations and returns only after in-flight commands and ACK reconciliation settle. Commands already sending linearize before the cancel — recall cannot be promised; later stops read the post-settlement authoritative run state. The barrier manages only in-flight Host calls, stores no accepted input, and does not replace the CLI CommandInbox.

```text
prepare(generation N) -> recheck N inside serial barrier -> send/ACK reconcile -> release barrier
cancel -> generation N+1 (rejects unsent N) -> wait for in-flight sends to settle -> cancel done -> authoritative stop
```

Regression must cover: a cancel not completing early while an attachment-free send hangs internally; old generations waiting on the barrier being rejected; barrier release after send failure; CLI idempotent passthrough for new-generation input and the same commandId; and remote session identity isolation. Control commands/approvals/questions use their dedicated channel — they trigger no ordinary-message interruption and are never blocked by material preparation. Undelivered results of an interrupted old round must not be sent as final results; already-sent content is kept.

### Input materials and display

First display shows the root reference (real original, sender, time) and an openable topic-history text attachment. This turn's body stays as-is; an @ alone creates no placeholder body or empty bubble. Later messages display sender, body, and attachments independently — even batch-executed, never merged into one UI bubble. root_id is not an explicit quote; a quote is appended only when the user explicitly quotes another message. No repeated root references or bot_topic_context injection.

History is read once at first; ongoing messages are collected via events; reconnects/gaps fetch increments. At most 200 messages are auto-read per pass plus the root message kept separately, deduplicated by message id, with coverage and gaps recorded. The history text contains time, sender name and id, message id, body, attachment names/types/references. Required attachments of the current and explicitly quoted messages are prepared through the existing upload flow and submitted at once; other history resources are looked up within the task's authorization scope. No lark-cli dependency; history commands and approval text are never control input.

Preparation/waiting-stop uses OneSecond, execution OnIt, the corresponding turn's completion CheckMark, failure CrossMark. Interrupt/cancel removes unfinished emoji; each input independently binds its run — later completions never back-mark old messages. The UI uses light preparing/waiting-stop/retry states; interrupted answers are kept and marked "interrupted by a new message". No queue cards, BotGroupTaskNotice, or duplicated source bodies are restored.

### Protocol boundary of interruption attribution

The App never infers auto-interruption from message order. When the CLI's activeWorks owns input attribution, it carries an optional sourceCommandId which, with foregroundExecutionId, identifies this run; without input attribution the normal stop display remains. When a new bot message stops, the authoritative mapping records the interrupted input; manual /stop and /leave write no auto-interruption cause. The UI reads the cause via the same task's bot state subscription — no new runtime, no accepted queue, mobile keeps its replayable boundary.

```text
CLI activeWorks(executionId, sourceCommandId)
  -> bot new message stops that executionId
  -> auto-interruption cause of the original input
  -> App stop label for the matching sourceCommandId
```

### Preparation-state display boundary

The bot service temporarily holds unsubmitted messages and preparation state; getBotStates projects only messageId, sender, body, and preparing/waitingStop/failed — no attachment bytes or credentials. The App projects preparation messages into the conversation stream; after failure it removes the temporary row and shows no error block or retry. Once the CLI accepts, the temporary display is removed immediately and the formal CLI row displays; cancel, exit, revocation, and close clear the temporary state. The cache is not persisted, never auto-rerun, and not an accepted queue; after a service restart materials are rebuilt per the existing history boundary.

### Message bubbles for in-preparation input

Each in-preparation human input belongs to the conversation stream. The source row shows 「飞书/Lark · sender」 with a non-shrinking loading icon; hover or keyboard focus on the icon shows a tooltip 「正在准备材料」 (preparing materials) or 「等待当前执行停止」 (waiting for the current run to stop). No persistent preparation text inside or below the bubble. The body reuses the full formal message component and collapse/expand; an empty body shows only the source and status icon — no empty bubble. After material preparation fails, the temporary row is removed with no red error block, retry button, or orphan source label; server-side failure records, execution, and the Feishu-side reply are untouched. Long names truncate without squeezing out the status icon. The provider comes from the current bound bot's config or the received source — never guess Lark as Feishu.

```text
Bot unaccepted material (messageId) -> timeline render unit -> formal body component + source-row loading icon
CLI formal message (botGroupSource.messageId / messages[].messageId) -> formal bubble
                           └-> same-id preparation bubble no longer displayed
```

Preparation messages join the ConversationTurnGroup and participate in existing message-flow measurement/scrolling — no separate hint at the timeline bottom. The running live tail is kept; running turns are never moved into the history virtual list for preparation state. Display derives only from the current timeline and bot state — no extra cache or accepted queue; messages are still published by their owners. When the formal message with the same original id arrives, the late preparation state hides — never dedupe by body matching. Reusing one bubble component does not mean keeping one DOM node across owners. Desktop continuous and mobile replayable keep their paths. Acceptance covers multiple inputs, empty bodies, preparing/waiting/failed, retry, the overlap window where the formal message arrives first, plus zh/en, dark/light, desktop/mobile widths; component browser evidence does not replace real Feishu and mobile remote end-to-end.

### Implementation and acceptance record

- Covered by regression tests: late material cancellation on service dispose, bot removal, or owner rebinding; retry matching the current taskId and workspaceIdentity, with old callbacks after cancel unable to update the new-generation state; root-reference attachment dedup at submit with recomputed indexes; old topic queue/Steer discards updating only the original input state without queue notices; dedicated-topic root validation and one-time alias migration; original senders, quotes, and attachment indexes surviving the snapshot schema.
- Automation: group service 81, agent projection 177 cases, plus dedicated stop-coordinator, runtime stop-barrier, preparation-state, original-message display, and interruption-label tests. Pre-submit `NODE_OPTIONS=--max-old-space-size=8192 pnpm verify:pre-push` passed (lint 43 pre-existing warnings, 0 errors); staged content checked separately — 15 modified test files and the 24 modified source files' full related set (893 test files, 9,916 tests, 4 skipped) pass. Node 24.14.0's threads pool SIGSEGV'd in V8 GC threads even with a raised heap cap; the final run used isolated processes — no check rules were disabled.
- Open: real Desktop/mobile preparation display, persisted restart, and mobile replayable display await manual acceptance; dev not started, no UI E2E run. Real Feishu/Lark, Desktop/mobile, cross-OS, and real restart recovery follow the materials doc's manual steps; automated tests do not replace these.

Full history: git show f26734ad:docs/bots-feishu-group-collaboration.md

### Migration and verification boundaries

Old standalone tasks are kept; topicAliases pointing at the default task serve a one-time migration only — at a safe idle boundary an independent task is created, an independent binding saved, and the old alias deleted as the completion record. The original task is kept; the full old context is not copied. The resident alias route is removed; no dual topic-execution implementations are maintained.

Desktop continuous, mobile replayable, owner/lease, workspaceIdentity, and remoteSessionId keep their boundaries. Automated verification covers stop races, concurrent joining, message dedup, material failure, revocation, and migration; real Feishu/Lark, Desktop, and mobile display are manually accepted by the user — dev was not started. Unfinished real verification must be listed explicitly in the delivery.

### Historical attachment retrieval (local/stdio/WebSocket integration under verification, 2026-09-08)

Remote forwarding uses a private reverse channel on the existing Desktop-to-server stdio connection. Only the credential-owning Desktop Host authorizes/downloads the resource. The source connection must validate the current logical workspace and remoteSessionId before invoking Bot authorization. The model cannot choose a Host, URL, credentials or transfer destination. Desktop and mobile stream profiles remain unchanged.

Resource transfer uses begin/chunk/finish/cancel, at most 384 KiB per decoded chunk and the existing 20 MiB attachment limit. At most two live downloads per connection are retained for 120 seconds; overflow rejects immediately without queuing. Every chunk and finish rechecks the original authorization. Cancellation, timeout and connection close abort downloads and erase retained bytes. The receiver checks the declared byte count and SHA-256 before passing the file to its existing CLI uploader. This short-lived resource transfer state is not an accepted input or execution queue.

For a shared WebSocket Server, register a private resource peer only on the existing capability-authenticated `/ws/host` connection. Bind workspaceIdentity + remoteSessionId from trusted V4 facade calls, never message bodies. Two live peers cannot claim the same route; closing a peer removes its routes. A normal `/ws` mobile/browser connection cannot register a resource peer. Each reverse request resolves exactly one peer and the Desktop then revalidates its own current logical session and Bot authorization. There is no last-client fallback, broadcast probing, reconnect or new runtime.

```text
Remote CLI -> remote Host -> same stdio reverse channel -> Desktop Host
                                                        authorize + download
Remote CLI <- existing attachment uploader <- bounded chunks + final authorization
```

Native verification found that a file reply in the dedicated topic UI offered forward, recall and selection actions, but no quote-reply action in the inspected client. The archive retains a file placeholder; the optional `ReadSessionContext` topic attachment selector now requests the original resource through a trusted input and authorization generation. Local, SSH/WSL/Docker stdio and standalone WebSocket Server integration are under verification; controlled transport tests do not establish native end-to-end acceptance.

The Host `readTopicResource` service now resolves a trusted input ID to its accepted task/topic archive and validates the supplied authorization generation, group history opt-in and workspace identity. It rechecks authorization around native I/O and returns one size-checked transport-ready attachment. Provider metadata lookup supports file, image and rich-text image messages; cancellation reaches the native download. This service is the download boundary. The local Agent reverse request uses existing chunked upload into its own CLI, validates the bytes and writes a session binary artifact. A final authorization check runs after upload before returning the reference. Stdio callbacks use the bounded private reverse channel described above. Native local/remote file materialization and original-topic delivery remain pending verification.

The retrieval capability must bind to the executing task, not model-supplied bot/chat identity. A model may select a message/resource reference already present in that task's admitted topic background; it cannot request arbitrary group history. Host validates the current task/workspace identity, parent and topic authorization generation, and the original native message's chat/thread before downloading. Recheck authorization after network I/O before exposing bytes. Disabled/rebound/unrelated topics fail closed.

```text
current task tool -> typed Agent/Host request (archived message reference)
                  -> Host task + workspace + group/topic authorization
                  -> native message/resource verification and download
                  -> existing chunked target-runtime attachment transport
                  -> bounded tool result / target-local resource reference
```

Reuse dependency-injected Agent ports and reverse protocol requests; keep provider credentials in Host. Maintain cancellation, resource lifetime and atomic failure semantics. Remote requests carry workspaceIdentity and remoteSessionId and return target-accessible resources, never Desktop absolute paths. This lookup is read-only task work, not a new input queue, approval response or change to execution policy.

Required regression: an archived same-topic file can be read on demand; an unarchived, cross-task/chat/thread reference, revoked authorization, failed download or interrupted transfer returns an explicit failure without exposing partial data. Native acceptance must ask for a value found only inside the file, verify runtime content and original-topic delivery, and separately record remote workspace coverage.

Group enable/disable is group-wide. Within a topic, new/clear instruct the owner to open another topic; task displays its bound task without cross-topic switching. Stop, configuration and interaction controls affect only the bound conversation, subject to existing role/busy restrictions. Group reauthorization rotates the version for all topic contexts; pending deliveries are invalidated, not replayed. Every send/card action checks group authorization plus topic/task/run/request identity. An unavailable source message may fall back only to the same thread; never to main chat or another task.

UI reuses task list/conversation/queue/approval surfaces. Title defaults to group plus topic title. The reply action bar does not expose topic details or a topic context dialog. Summary corrections are ordinary task input. Only failed or unknown deliveries expose recovery controls in reply actions; do not restore BotGroupTaskNotice or composer result panels. Desktop continuous and mobile replayable boundaries, owner/lease and workspace identity remain unchanged.

Acceptance includes two ordinary topics, dedicated topic groups, bot-result follow-up, plain-message silence, incremental overlap/ACK races, long-context/gap/summary conflict, cross-topic card attacks, disable/restart/remote disconnect, attachments and delivery. Run protocol/service tests, Desktop E2E/mobile regression and real pnpm dev:desktop CUA against Feishu; record Lark/cross-platform limitations separately. Automated fixtures are not evidence of real tenant permissions or native topic behavior.

Service-level card acceptance explicitly verifies sibling-topic attacks: a queue card from topic A used in B, another chat, with another task or an old authorization version must return a toast-only rejection before calling CLI cancellation. An unrelated member cannot cancel A's input even with its otherwise valid card. The original author may cancel the matching A input; B's input remains accepted. Re-enabling the parent group must not make either topic's earlier cards valid again. These controlled tests establish service authority only, not native callback delivery or multi-device timing.

## Inputs and commands

Only user messages mentioning the current bot are admitted. Strip only that bot's mention; preserve other mentions. Deduplicate by provider message ID, not text or event ID. Text and rich-text images are supported. A reply mentioning the bot can attach the explicitly referenced image/file from the same chat (and same topic when applicable). Topic history follows the opt-in contract above. Attachment preparation is all-or-nothing and uses existing size/type rules.

Everyone can submit prompts and use help/status. Only the initiating actor or the owner can answer ordinary questions or cancel that actor's queued request. Only the owner can enable/disable, new/clear, stop, workspace/project, model, mode, think, reconnect, task, or approve/deny permissions and plans. Existing command policy also applies. Bind remains private-only; reply granularity is fixed to summary in groups. Help is role-aware; cancel only cancels a menu. Ordinary text never implicitly answers a group interaction. Desktop/mobile questions belong to the owner. The first valid answer wins; stale or unauthorized callbacks do not mutate cards. Owner authorization is checked in the service, not in card markup.

`/new` creates a draft; the next prompt creates the task. Old tasks retain history but lose active delivery. Task history/selection is restricted to this group. Running, pending interaction or queued input blocks task/workspace switching. Stop retains the canonical Desktop queue semantics. Queue cancellation operates on the CLI item; racing execution cannot stop the whole task. Message edits/recalls do not automatically cancel, edit or roll back accepted input.

## One input queue and delivery

```text
group mention -> verify/deduplicate/prepare attachments --+
desktop/mobile input -----------------------------------+-> owner route
                                                          -> CLI CommandInbox
                                                               |       |
                                                     UI projection   group result
```

Group input requests FIFO delivery, never automatic steering. Order is CLI admission order, not client timestamps or attachment download start. Acknowledge only after admission; queued replies offer cancellation. Stable command IDs allow ACK recovery without duplicate execution. Interactions and cancellation bypass ordinary input queueing. Text and attachment references survive queue operations, promotion and transcript persistence. No second accepted-input queue in the Host, Bot service, renderer or relay.

Groups receive final per-input summaries, necessary questions/approvals and terminal failure/stopped/discarded status, never streaming/tool progress. Replies reference the original message when possible. Do not prepend the sender name or open_id to reply bodies, including stopped/failed/discarded notifications. Desktop/mobile source labels remain for inputs from those devices. A recalled source falls back only to the same authorized group. Desktop/mobile inputs also deliver to the currently attached group. Private replies keep streaming cards.

Group message reactions reflect canonical input lifecycle instead of permanent OK. Only after CLI admission may a queued input show waiting; direct execution shows working. Run start replaces waiting with working, completion shows success, and failure shows error. Cancellation/stop removes the bot's status reaction and keeps the existing textual explanation. Late admission acknowledgements cannot overwrite running or terminal state. Repeated events must not stack reactions. Only this application's reactions may be replaced; member reactions are untouched. Provider failures are presentation failures and never resubmit or reject an accepted input. Native emoji mapping: waiting `OneSecond`, working `OnIt`, success `CheckMark`, error `CrossMark`, cancelled/stopped no reaction. On mutation, list the message's reactions to reconcile this application's status after restart; never delete member/other-app reactions. This does not resume discarded work. Queue acknowledgement uses one compact row with localized waiting text and a cancel button, preserving the existing authorization and command payload. The same queue card follows the input lifecycle: waiting (cancel enabled), working, done, failed, stopped, cancelled or discarded (all without cancel controls). Persist the card message ID and input state per canonical input. A card whose creation completes after run start/completion must immediately catch up to the latest state; late admission and repeated events cannot revert the card. Serialize card mutations per input and recheck group authorization/current task before each update. Card failures never replay execution. Existing cards without a saved message ID are not discoverable by scanning group history.

Persist task/group association and result delivery records, including stable send IDs and payload, to support Host recovery and result-only retry. Revalidate bot, group and active task before every send/retry. Disable/task-switch invalidates old pending delivery. Unknown send outcomes require reconciliation; retries must not rerun the task. Respect rate limits and split oversized results. Scheduled output also rechecks group authorization. No replay of output suppressed during disable.

## UI, authority and recovery

Reuse existing desktop/mobile task, transcript, queue and approval components. Show group/source/sender in the task and transcript. The composer does not show a persistent group-sync or shared-workspace banner (2026-09-07 product update). Only unresolved delivery failures/unknown outcomes show the recovery panel; it disappears when all results are resolved. Delivery failure has result-only retry. Status uses workspace display names, never internal absolute paths or credentials.

Default group execution requires approval, without inherited private auto-grants; only owner-controlled configuration/approval changes policy. Source metadata is trusted attachment data, never authority derived from prompts. New protocol data has strict runtime schemas and remains backward compatible for private inputs. Persist group state separately from private bot state, serialize shared-file writes.

Keep desktop-continuous, web-remote-replayable and bot subscriptions separate. Preserve owner/lease/stale-run routing, workspaceIdentity and remoteSessionId. Disconnected remotes only reconnect via explicit reconnect; do not run locally. UI rebuilds use existing queue recovery; CLI restart retains the existing explicit discarded semantics. Runtime logs omit secrets/content; high-frequency logs are debug.

## Acceptance

Tests cover owner activation/revocation; two groups and private isolation; exact mentions; duplicate delivery; attachments and cross-chat rejection; one mixed-source queue; cancel/start races; actor/owner interaction rules; stale multi-client cards; approval isolation; draft/new/history switching; stop/disable/removal; per-input summary and Desktop delivery; rate limits/unknown outcomes/result-only retry; Host/CLI restart and remote boundaries; mobile, themes and locales. Implement tests before code. Run typecheck, lint, focused unit/integration and Desktop E2E. Real Feishu and cross-platform results must be reported separately from fixture tests.

### Feishu API permission check (2026-09-07)

Receiving group @ events uses `im:message.group_at_msg:readonly`. Reading explicitly quoted messages and their attachments additionally needs the app-identity `im:message:readonly` or `im:message` — a different permission from subscribing to all group messages (`im:message.group_msg`). Configuring only the @ event permission does not guarantee attachment download success. The bot must still be in the original message's group and pass server-side same-group checks; insufficient permission, invisible message, or undownloadable attachment fails the whole input — no partial execution of remaining text.

Basis: [get a message](https://open.feishu.cn/document/server-docs/im-v1/message/get) (updated 2026-04-10), [get a message resource file](https://open.feishu.cn/document/server-docs/im-v1/message/get-2) (updated 2026-08-27). The full-group history query API is not used.

### Delivery reconciliation

An uncertain send is never retried automatically. Desktop/mobile expose delivery recovery beside the timestamp in the corresponding completed reply action bar. No recovery panel is mounted above the composer or queue, and saved result bodies and sender IDs are not repeated. A compact localized icon opens a popover with retry or reconciliation actions; successful and in-flight sends render nothing. Persist an optional sourceCommandId from the trusted task event inputId on each delivery segment. Match it against canonical user-input rows in the product turn; runtime turnId is not the product turn ID. Records without a source command are not guessed onto another reply. The service projects in-flight delivery as pending while preserving crash-safe unknown persistence; after the operation settles it broadcasts the final state. The operator can mark it received, or confirm that it was not received; the latter changes it to a definite failure and exposes the existing resend action. This reconciliation does not execute a task or read group history. Both reconciliation and resend recheck the current group authorization and task association. Concurrent delivery still in flight cannot be reconciled. State changes use the same serialized persistence path as group lifecycle changes.

Input origin labels use an optional `inputOrigin` (`desktop` / `mobile`) injected by the trusted Host command attachment, never inferred from prompt text or a client-supplied client ID. It travels with the canonical input through queue, retry and transcript restoration; bot sender metadata takes precedence in group replies. This display field does not change continuous/replayable delivery modes.

Each historical group task also retains its workspace path and optional identity. After changing the current workspace, `/task` can still list that group's earlier local/connected workspace tasks, and Desktop can label an earlier task as paused. The history map is not an access grant for unrelated tasks or a request to connect a disconnected remote workspace. Older records fall back to the current workspace.

The per-message input association persists its admission outcome. A repeated provider event for an accepted input never issues a new admission, including after Host/CLI restart. An unresolved admission is reconciled through the existing stable command query while the original request is active; later redelivery does not guess that an unknown command was never executed. It reports that the operator must check the task, rather than submitting that message again after dedupe expiry.

Remote group controls use the already validated attachment scope:

```text
Bot group input / queue control
  -> existing remote MessagePort attachment
  -> Host injects workspaceIdentity + remoteSessionId
  -> task adapter validates the loaded task's workspace identity
  -> existing Agent owner route / CLI CommandInbox
```

The three group queue service methods carry optional remote target fields for compatibility. A target from another workspace is rejected before uploading any attachment or reading/changing its queue. Local calls retain their existing target.

Saved deliveries retain the group authorization generation that created them. Disable/re-enable, bot removal and rebinding cannot make an in-flight retry valid again merely because the same task remains current. Every retry checks both the saved invalidation status and that generation immediately before sending.

Group task creation requests `permissionScope: session` on the V4 create command. Only this path persists the task immediately and initializes an empty build-mode session ruleset before acknowledging creation; normal Desktop drafts stay deferred. Group draft configuration is applied afterwards, so an owner's explicit mode choice is retained and cannot update the shared project ruleset. The first-input guard remains for older group tasks, but does not reset an already isolated session.

## Group member display names

Group attribution resolves names from the current chat's member directory using `GET /im/v1/chats/{chat_id}/members?member_id_type=open_id`, with the application permission `im:chat.members:read`. Private chat contact lookup remains unchanged. The provider follows pagination, coalesces concurrent requests, and caches names per provider, bot, application, credential reference and chat for one minute. Failures receive a short retry backoff; partial directories are never published.

A read-only service authorizes directory access against the enabled bot and group, including a second authorization check after network I/O. The UI shares one lookup across historical messages and queued inputs without rewriting saved source IDs. Current names take precedence over saved names. Missing names use only the last six ID characters, without a generic member label; hover and click/tap expose the full ID. Names never participate in authorization. Directory failure must not reject otherwise valid input or delay task/delivery status rendering. No task queue or Desktop continuous / mobile replayable semantics change.

Validation covers pagination, request coalescing, failure backoff, bot/chat isolation, disabled/rebound access, history and queue attribution, fallback and full-ID disclosure. Real tenant verification is separate from controlled E2E.

Conversation attribution has an 8px gap before the message bubble, using the shared spacing scale. This applies to Desktop and mobile conversation rows; queue attribution retains its compact layout.

# Topic original-text lookup contract

The Agent reuses `ReadSessionContext`'s `topic` strategy to look up original topic text saved with received inputs; it reads only the current session, filtered by message id or keywords and paginated. Originals come from the trusted `conversationInputIntent.botGroupSource.topicContext`, falling back to old `inputIntent` only when the authoritative field is absent; identity is never parsed from body text, and summaries are never treated as originals. Read limits, gaps, and truncation must be returned to the model; not-yet-fetched messages are never claimed archived. The next @'s bounded native API read still handles new archival.

The strategy calls no extra model, executes no commands or approvals from history, changes no queue, and reuses the existing read-only tool permissions, cancellation, trace, result budget, and tool-result projection. Task summaries come from the model-only `bot_topic_context` record; both originals and summaries keep their reference basis.

Implementation boundaries: coverage is expressed by archived message ids, the current wakeup checkpoint, and `hasGap`; the message count of unreadable ranges is not inferred. The reply action bar offers no topic-details entry or summary dialog; removing this UI does not change the server-side topic archive or original-text lookup. Lookup covers only already-read, received input background; unread earlier history is not auto-fetched online by this tool. Real-tenant and cross-platform acceptance state is recorded in `docs/testing/bots-e2e-coverage-matrix.md`.

## Explicit quotes vs mention-only (2026-09-08)

- A plain main-chat message triggers no execution. Main chat with only @, no quote or attachment, returns a supply-more-guidance prompt — no task or execution emoji.
- Explicitly quoting text then only @: the request is to handle the quoted message; the original stays as quote material with its message id. When the @ carries a new request, the new request wins. Commands inside quotes never go through the command parser.
- Quoted text, rich text, and attachments must be readable and belong to the same group/topic; unreadable, recalled, or unsupported-format items are explicitly rejected — never silently ignored.
- Only @ inside a topic: submit "handle the explicit question with the discussion; ask if intent is unclear" only when the group has history reading enabled and usable topic background; otherwise prompt for more input. A history-read failure never executes an empty request.
- Explicit quotes do not depend on the history switch; main-chat `@ hello` never implicitly reads adjacent messages. Attachments and quote text enqueue once; no execution/queue emoji before CLI confirmation.

```text
trusted @ -> native quote validation -> keep current request + quote material
       -> empty request: explicit quote / authorized topic background / supply-more prompt
       -> one CLI admission -> emoji and in-place reply
```

### Group input after cold start

After a real dev-environment restart, the default group task still exists in the database, but when the bot submits a V4 command directly the runtime has not loaded it and returns `proto.sessionNotFound`. Group input obtains the original task's authoritative CLI snapshot through the existing background subscription before attachment upload and admission, reusing the cold-recovery READY barrier; on failure the input is rejected — no new task, no replay of historical inputs. Workspace identity and remote session pass through unchanged. Desktop continuous and mobile replayable paths are unchanged.

Cold-start recovery must also obtain the authoritative snapshot before establishing the bot continuous result subscription; otherwise the old-session subscription exhausts retries while the session is not loaded, and later inputs execute successfully but get no result push-back. This recovery reads state only — it submits or replays no input; remotes still check existing connections first.

Quote-only evoked model input explicitly delegates "answer the question in the quoted message or complete its request"; the quote segment only marks provenance. Command isolation happens server-side before concatenating the quote — no vague "this is not an instruction" hint preventing the model from handling the user's explicit quoted request.

## Access token validity

Real-group @-only verification found: events were received normally, but the prompt delivery returned `99991663`. The Provider had cached each token for a fixed 90 minutes, ignoring the remaining validity seconds returned in `expire`; holding an existing token does not mean regaining full validity. The cache must use request start time plus the returned `expire`, keeping the 60-second early refresh. Missing or invalid validity is not cached and validity is never guessed; the current valid token is still usable for the current request. The fix replays no failed requests and changes no queue or desktop-continuous / mobile-replayable path.

```text
read cache -> remaining validity > 60 seconds -> use
         -> no -> fetch token -> save validity by expire -> call
```

### Bot attachment admission connection identity fix (2026-09-08)

Native rich-text messages triggered `fault.attachment.connectionUntrusted`: the bot task adapter called the bare Agent attachment API without the existing V4 connection scope injecting a trusted connection identity. The fix reuses an independent connection scope for bot access keyed by workspace identity and remoteSessionId; bot snapshot, attachments, admission, command reconciliation, and cancellation for the same target share the connection. No new runtime or queue; Desktop continuous / mobile replayable attachments are unchanged. Workspace identity and remoteSessionId keep passing through.

```text
Bot task adapter → Bot trusted connection scope → existing Agent client → CLI CommandInbox
                    └ attachment begin/chunk/commit use the same connection
Desktop / mobile → existing own connection scopes ────────────────────┘
```

### 2026-09-08 topic interaction card delivery regression

In a real CEDAR topic, an approval card appeared in the group main chat. Temporary approval/question cards must use the same topic anchor resolution as ordinary replies: prefer replyToMessageId, then rootMessageId; with a threadId but no anchor, the send fails — never fall back to group main chat. Card creation must pass reply_in_thread; later updates keep the same card. Both creating and updating interaction cards keep the group, topic, task, and authorization version from groupCard; the temporary card path cannot bypass ordinary group-card identity constraints; normalizing the permission mode to streaming_card must not drop these fields.

### Standalone Server reverse resource regression

Both HTTP Server entrypoints require transport tests on real loopback WebSockets: only capability-authenticated /ws/host attaches a resource peer; ordinary /ws does not. Two simultaneous Desktop connections with different remoteSessionId values must receive only their own reverse validation requests. Closing one connection removes its route without removing the other. These tests use synthetic resource readers, not a live tenant.

## App bound group chat (phase one)

In bot settings, below the current Feishu/Lark bot's workspace access scope, a flat group list is shown. Visually it reuses the bot-settings SettingsGroupCard, with title and rows uniformly px-4/py-3 and borders/background/radius matching adjacent settings. One row per group: group name (long names truncate, title kept), recorded topic count, and a group-level toggle; no tasks, topic details, expand arrows, or detail entries. The topic count is the number of distinct threadIds recorded for the current bound user, including exited topics — not the group's real total topic count on Feishu. Only the current botId's and ownerId's group-default records are shown, topics aggregated per chatId, private chats excluded.

```text
group list hook -> getBotStates -> group-default records + deduped topic count
group toggle -> setGroupEnabled -> existing group authorization owner -> bots:group-state -> re-read
```

The UI makes no optimistic authorization change; the toggle is disabled while saving and shows a retryable error on failure. After switching bots or closing the page, late reads do not update the new page. The list refreshes on the group state broadcast; re-enabling replays no history. Disabling a group keeps its tasks, following /disable's invalidation semantics for input, cards, and push-back. When the bot master switch is off, group config is kept but group toggles are disabled with a reason; a group toggle never auto-enables the bot. With no bound groups, guide the user to @ the bot in a group and send /enable. A load failure must not render as an empty group list. Existing services/RPC are reused; desktop-continuous and mobile-replayable task paths are unchanged.

Manual acceptance: zh/en, dark/light, narrow-screen single-line truncation; two bots/two groups without cross-talk; 0/multiple topic counts; state sync on switch and reopen; disable/re-enable keeps tasks and replays nothing; failure recovery retryable. Per the user's request, dev was not started for this phase; real UI and mobile remote are manually verified by the user.

## Group reply quotes and sender reminders (2026-09-23)

Direct replies in groups (task results, commands, supply-more prompts, errors, approval and question cards) use the Feishu native quote and @ the current asker with their real user id at the card start. When the user quotes someone else to ask, both the quote and the @ point to the current asker, never the quoted material's author. In a topic, the sender is @-ed only when the triggering message explicitly @-ed the bot; ordinary topic messages quote but never @. Group main chat and private chats keep their behavior.

Each turn reads the existing inputs.source by the trusted inputId; the target is never guessed from the most recent speaker, group owner, or the previous turn's source. Topic batching quotes source.messageId (the batch's last message); the first body reply @-s the deduplicated senders who explicitly @-ed the bot in the batch, in input order; un-mentioned participants are not reminded. Long answers quote the same message per segment, @-ing only the first; independent interaction cards remind separately, and PATCHing the original card adds no reminder message. @ is display-only and never changes approval/question permissions.

```text
group message → existing input source (message/sender/batch list) → CLI accepts input
      → result with inputId → bot determines the reply target → existing delivery persistence
      → same group/topic authorization check → Feishu native reply + card at
```

Input and queue stay with the existing owners; delivery stores only the reference, mentionedUserIds, segmentation, and stable delivery id of the generated result. Retry restores from that record without re-resolving senders from current group state. Desktop/remote tasks keep bot-channel-continuous; the mobile replayable boundary is unchanged. Client or scheduled results without a trusted group input generate no personal quote or @; topic placement still uses the original topic anchor. Old deliveries without mentionedUserIds keep their behavior — no guessing, no backfilled reminders.

Source-message invalidation degrades only after an explicit rejection: an ordinary group drops the quote but keeps the @ in the original group; a topic first tries one different valid root anchor, and if that is also rejected it fails — never degrading to group main chat or looping. Timeouts and other uncertain outcomes stay unknown with no auto-resend; rate-limited and post-restart allowed retries keep the original reply target; disable/rebinding still invalidates delivery via the original authorization generation. Commands and temporary cards follow the same quote-degradation rules.

Acceptance: single person, interleaved multi-person, quoting others, topic batching, long-answer segmentation, commands and independent interaction cards all associate correctly; no-source and private chats add no reminders; recall/root-anchor invalidation/rate limit/timeout/restart never cross-wire, loop, or double-deliver. Unit tests assert routing, cards, and persistence; real Feishu client quote jumps, @ display, and notifications need separate real testing — not inferred from mocks passing.

### Topic model inheritance boundary (2026-09-23 fix)

A new topic reads the structured model snapshot from the group's current task's getTaskModelSelection, keeping providerId, modelId, and options.reasoningLevel; never infer from the model config menu or the task.model display value. For example, a displayed GLM-5.3-Flash$max inherits the model GLM-5.3-Flash with an independent max reasoning level. While the group is still a draft, it inherits the draft's explicit draftOptions; after topic creation the snapshot is its own and never follows the group's later model switches. Existing broken drafts need explicit repair — no runtime compatibility for a wrong modelId was added.

## Admin todo reminders (2026-09-23)

When group chat or a topic needs an admin, a real @ is generated with the bound bot.providerUserId as the sole recipient for: admin-only operations rejected, permission approval, plan approval, group not enabled, history off, unresolvable model selection, workspace unavailable or out of scope, remote disconnect/reconnect failure. Ordinary questions, task results, and generic tool errors are never escalated to admin todos. Insufficient Feishu app permissions only produce the app-admin configuration guide — never assume the bound user has app-admin rights.

The admin reminder replaces the ordinary sender reminder, keeping the native quote and original topic placement. Unauthorized card clicks still only toast; the first time admin help is needed, an independent notification is sent — the shared approval card is not updated and the clicker gains no permission.

```text
service identifies admin todo → current bound identity + group/topic + reason/approval request
                   → in-process notification dedup → existing send/interaction card chain
new input accepted / corresponding blockage resolved → clear the blockage reminder record → later blockages can remind again
```

Dedup is only a bounded in-memory notification record — no new task/input queue; after a service restart or capacity eviction, reminding again is allowed. While the same blockage persists, later prompts keep the text but stop @-ing; different topics, admins, or approval requests are independent. Approval-card PATCHes generate no new reminders; ordinary follow-up questions do not consume the admin reminder record. Acceptance covers the positive/negative scenarios above, repeated multi-person operations, topic isolation, re-reminding after recovery, and button rejection not mutating the original card.

## Native mention nodes and channel replies (2026-09-23)

No deferral rules were added. Trusted Feishu mentions are kept in BotGroupInputSource.contentParts in original order, saved per message in batches; appId, together with the existing botId/chatId/threadId/messageId, scopes the app and conversation. text stays a compat projection and must equal the node concatenation; clients render only from trusted nodes and never recover identity from @name text. Plain text, names, and quote material are never send addresses by themselves; names resolve to sends only through the Host query below. Unknown target types allow native mention; @everyone never enters personal nodes.

Input → Provider nodes → existing inputs.source / canonical intent → queue / transcript / desktop continuous / mobile replayable
Execution → ReplyToChannel(refId, text parts) → CLI executing-input identity → authenticated Host reverse request → bot task-binding check → existing delivery → Feishu receipt

ReplyToChannel is only for extra native replies the user explicitly requested; it cannot target an arbitrary group, bot, or bare id. The service uniquely resolves the currently bound group chat/topic by workspace and task, validating the authorization generation and appId; the current input need not carry botGroupSource. Quote nodes may come from native messages already received by that task under the same valid binding, supporting desktop and mobile follow-ups like “再 @ 一下他” (@ them again). Results distinguish sent/failed/unknown/invalidated; only sent confirms delivery; a stable toolCallId maps to one delivery record. Nodal bodies generate native ats in order; @name or Markdown in ordinary model output is never parsed as a send command. System-originated/admin reminders dedupe against body mentions; body mentions never change approval permissions. Old messages without nodes stay text — no id guessing; nodes of other tasks, group chats, topics, old authorizations, or rebound apps can never become send targets.

The tool takes the executing inputId from the persisted toolCall's assistant.parentID; channel binding and target resolution are exclusive to the Bot Host; later queued inputs cannot replace the in-flight send target. Before sending it also checks that the input was not stopped/cancelled and the app was not rebound. Body limited to 1–2000 characters, one delivery per message; retrying the same toolCall returns the persisted receipt; uncertain outcomes are never auto-resent. Cancellation blocks submission before the Host request; once sent, delivered messages cannot be recalled — a caller cancelling or disconnecting does not count as not sent. trace is kept through the reverse request, remote forwarding, and delivery record.

Client formal messages, preparation state, and the queue share the channel chip (@name + Feishu/Lark); old messages without nodes keep their display. Copy or recall into a plain text editor carries no channel send authorization; sendable identity is never reconstructed from strings. When display-layer text and node projection disagree, fall back to plain body so stale target association is not shown after edits.

ReplyToChannel is approval-free by default: in build, edit, and plan modes, replying to an already authorized session needs no permission popup; it is still marked a real network side effect, never disguised as read-only. Explicit project deny/ask rules keep precedence. The exemption applies only to this built-in tool and its channel.reply contract; other network send tools keep their rules; the Host still validates task binding, session, app, and refId before sending — missing, ambiguous, or invalid bindings fail with an explainable error.

Acceptance: after a successful native Feishu @, appending “再 @ 一下他” from client/mobile still sends to the same group/topic; no binding, multiple bindings, rebinding, disabling, other-task/topic references, and cancelled inputs all fail to send. CLI → authenticated reverse request → bot state as sole owner resolving binding and history nodes → existing delivery idempotent send. No new cache or accepted queue; desktop continuous and mobile replayable input and recovery paths are unchanged.

### Mention by name (2026-10-08)

When the user explicitly asks to “@ someone/some bot” but there is no native node, ReplyToChannel accepts `{type: "mentionName", name, candidateRef?}`. @ text in ordinary final output never auto-triggers a send. The Host forms candidates from the current task's valid group-binding member directory (full pagination, the 60-second cache) plus trusted mention nodes already received under the task's same authorization; names normalize by Unicode NFKC, trim, and case-fold before containment matching; a unique candidate sends directly, multiple candidates prefer the unique full-name match, otherwise selection is requested. Platform ids supplied by the model are neither parsed nor accepted. English names keep internal spaces; explicit list separators (、, commas, newlines) form multiple mentionNames — names are never split on spaces alone. All names must be queried; the clarification result lists all unresolved items — later names are never skipped because the first failed, and un-queried or unsent are never reported as success. The member directory excludes bots; a bot never natively mentioned, without trusted identity, requires the user to native-@ it once. A directory query failure must never assume "no other namesake exists" and send.

```text
user explicit request → CLI ReplyToChannel(name) → Host validates task binding → query members + trusted nodes
  → unique candidate: resolve real id → revalidate binding/input/credentials → existing delivery → receipt
  → multiple candidates: needs_clarification + bounded candidates (name, type, distinguishing label, opaque ref), zero sends
  → no candidate/query failure: needs_clarification + reason, zero sends, ask user for a native @
user selection → new toolCall, name + candidateRef → re-query and verify candidate → send
```

The model never picks among ambiguous candidates itself. Candidates bind only to the current app, credentials, group, and authorization — never reused across groups/authorizations; the selection id carries no bare id and adds no pending-confirmation queue. If any target in a multi-target request is unresolved, nothing sends. At most 10 candidates are shown; beyond that, a native @ is required. The ordinary candidate list generates no @ notifications. The same toolCall's request fingerprint and resolved nodes persist with the existing delivery; receipt rereads do not re-resolve recipients against a new directory and never resend; changing name or body on the same toolCall is rejected. Old delivery records stay compatible. Async queries before sending cannot bypass rebinding, disabling, input stop, or workspaceIdentity isolation. App/CLI share a strict schema; ordinary desktop continuous, mobile replayable, and bot delivery owners are unchanged.

Acceptance: unique user, known bot, namesakes with explicit selection, no result, no permission, pagination failure, same name different id, authorization revoked during query, replay after the directory renamed within one call, rejection of cross-app/group/workspace candidates; Feishu/Lark and group/topic all covered. Real platform permission limits and missing bot directories are stated in the delivery evidence.

### Quote preparation and delivery replay boundary (2026-10-09)

When another bot native-@s in an ordinary group quoting a parent message, quote preparation and message parsing pass through the real sender open_id; without thread_id the quoted text and attachments are still kept; the bot itself still does not receive. A same-fingerprint ReplyToChannel replay with an active send must join the existing delivery owner's wait — the platform sends once and both calls get the final receipt. Persisted unknown is a crash-recovery marker; unknown is returned only when no active send exists — a replay never auto-resends. No queue is added; desktop continuous / mobile replayable boundaries are unchanged.

### Multi-bot identity and assignment boundary (2026-10-09)

The Host injects each turn's current bot config name and the Provider-verified own open_id (no guessing when old inputs lack ids), and keeps per-message mentionedBot and other native mentions. Identity comes from trusted metadata; names are display-only, never changed by body text, historical speech, or bot self-claims. The CLI's model context states clearly that a shared discussion is not a shared task: take on the part assigned to yourself only when explicitly @-ed; multiple people @-ed each follow the explicit split; follow-up without @ continues only your own task — no tool calls and no replies when unrelated; never announce completion of someone else's task. Plain typed @ without a trusted node is not hard-filtered.

Messages containing only other native mentions, not @-ing the current bot, enter as background at the Host gate: no slash control, no stopping the current run, no material prep or CLI submit, no reset or consumption of the inter-reply quota. A currently joined topic keeps only one backgroundHistory checkpoint and version marker (not an input queue); the next real input back-reads native history. The checkpoint is fixed at the last received message before the first background arrival; later backgrounds update the version without advancing the checkpoint, so inputs being prepared/submitted skip no background. The marker clears only when intake succeeds and the back-read version still matches; failures and restarts keep it. An inactive topic is never activated by background. A model turn without @ produces no visible output — no “任务已完成” (task complete) is sent; explicit @, errors, and real output keep their existing push-back. No new coordinating bot or separate assignment database; existing conversation storage keeps its duty.

```text
Provider identity and native mentions → Host gate
  @ others only → persist history checkpoint → original task continues
  @ self / follow-up without @ → back-read pending background → CLI injects identity and per-message addressing → handle own duty or stay silent
```

Desktop continuous / mobile replayable, workspaceIdentity, and the single CLI admission owner are unchanged. Acceptance covers same-name different id, plain-text @, multiple @, concurrent history preparation, restart recovery, un-joined topics, and empty replies.

### Keeping own mentions in original text (2026-10-09)

All mentions in a native message (including the current bot) are kept as ordered channelMention with name, position, target id, and refId — for UI, input persistence, and the model. Previously own mentions were replaced with empty strings, and multi-person assignment inputs lost the assignee of each work segment. The Provider additionally exposes a temporary commandText that removes only the leading run of own native mentions and adjacent whitespace; control commands and pure wake-up detection use that copy, ordinary messages always use the original. Mid-body mentions, other recipients, and typed @ are not stripped. Both text/post inbound formats follow the same rule; own-echo filtering, the bot inter-reply cap, and group identity verification are unchanged.

### Bot interaction-card exclusion (2026-10-09)

Bot cards with action controls only (buttons, selectors, inputs, forms) are not auto-reply input. interactive is only the Feishu card carrier — plain markdown/text conversation cards still participate normally. A bot's confirmation message quoting an action card is filtered the same way; replies quoting ordinary conversation cards are not. No reliance on Chinese/English confirmation copy. The Provider recovers trusted mentions from native mentions and the card's ordered at nodes; when the sender-side body id differs from the receiver-side id, use the platform's ordered mentions — never treat the raw body id as local identity. If a card event contains only the client-upgrade placeholder, read the real card through the same-group/topic native message API; a read failure submits nothing to the CLI. History filters action cards and the bot confirmation replies quoting them in the same batch via the optional controlCard class; ordinary conversation cards are kept; scan boundaries and checkpoints are unchanged. A human deliberately quoting a card or clicking it still follows the existing authorization flow. Own echo, the five-consecutive cap, desktop continuous, and mobile replayable are unchanged.

### Group chat stop silence (2026-10-09)

After a successful task stop in group main chat or a topic (including cancel and interrupt), no stop notification or status card is sent. Stop execution, input state, emoji, and task-list updates still complete; stop failures and no-active-task keep their error prompts. Private chat behavior is unchanged; CLI admission, desktop continuous, and mobile replayable paths are unchanged.

### Cross-task name lookup (2026-10-09)

Name candidates reuse native mentions of received history inputs with the same bot, app, provider, chat/thread, and authorization in the current group binding — candidates are not deleted by taskId or end state. Old-task identity participates only in mentionName resolution; old refIds cannot send directly; the current task's send authorization, revocation, concurrency rechecks, and directory-failure policy are unchanged. Other groups and other authorizations are never read, and ids in local bot config are never treated as local native ids.

### Review regression boundaries (2026-10-09)

History pagination first determines the call boundary/checkpoint from native metadata and excludes deleted messages, then expands cards within the window. A card read failure outside the window must not block input; a required-material read failure inside the window still forbids submission. During stopping, batch validity is judged per message by commandText/body, quotes, and attachments — the last message's command copy never represents the whole batch, and merged bodies are never re-parsed as control commands. The model's trusted mention projection computes isCurrentBot by native target id so a same-name recipient's exact position links to own identity without exposing other recipients' ids.

```text
history metadata → boundary filter → required card expansion → CLI admission
per-message input → stop barrier → whole-batch validity judgment → submit original messages
native mention targetId + current bot openId → isCurrentBot → model assignment
```

Current authorization, the Host persistence owner, single CLI admission, and desktop continuous / mobile replayable are unchanged.

Model identity location supplement: besides the mention list, per-message input projects ordered text/channelMention nodes so a native @ is distinguishable from visually identical typed text; each mention carries only ref, name, channel, and isCurrentBot. Batches group by messageId; repeated mentions keep each occurrence's position; the canonical original and persisted structures are unchanged.
