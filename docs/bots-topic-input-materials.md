# Feishu/Lark topic input materials

Access, stop/resume, and migration contracts follow [topic collaboration](bots-feishu-group-collaboration.md#topic-collaboration-implementation-contract): first access prepares the root reference and history attachments; after joining no @ is needed and the root reference is not repeated; a new message stops the old turn and resumes later. The input-material format below stays valid; older verification records do not count as this refactor's acceptance.

## Manual verification of the stop/resume refactor

The user starts this checkout themselves; dev is not started during implementation. In the Feishu test group, after enabling the group:

1. Post two plain discussion messages in the user's root-message topic, then @ for the first time. Open the standalone task in the ZCode task list; check the first root reference, the openable topic-history attachment, and the current attachments.
2. Send a plain message in that topic without @. It must continue the same task, show the real sender and body, and not repeat the root reference or first history.
3. Send two supplements back-to-back while running. The next turn starts only after the old run ends; the app shows both messages with attachments attributed to each; batched input never shows the concatenated internal execution body. Batched input has no per-item edit entry, so one message cannot overwrite the others in the batch.
4. Check each message's execution emoji; an interrupted input must not be marked successful by a later completion event. No “等待执行/取消排队” (waiting-to-run / cancel-queue) card appears in the topic; legacy queue cards must be invalidated.
5. Replying to a bot main-chat message creates a new topic and must create a standalone task. Open a second topic and confirm the two tasks and the group default task never cross contexts.
6. After `/stop`, plain input continues; after `/leave`, plain input does not execute and @ again restores the original topic task. Closing history or revoking permission must not leave partial execution.
7. Open the same task in mobile remote control; check per-message display, material preview, and recovery, in both light and dark themes. Feishu, Lark, mobile, and cross-OS real acceptance are recorded separately; untried items stay pending.

Automated results and commit state follow the topic-collaboration doc's acceptance record; older counts below are historical only.

The `/enable` permission guide also lists `im:chat.members:read` (view group members), noting it is optional — used to show sender usernames; without it tasks still run. Topic-history read permission stays required; do not use blanket copy like "missing any permission blocks execution". Chinese and English guides match.

A successful `/enable` reply (first enable, re-enable, or repeat) must include the admin permission guide: open the Feishu/Lark open-platform console, pick the bot app, grant app-identity message read permissions (including im:message.group_msg) under permission management, publish, then @ in the topic. Attach the platform console link and state clearly that enabling the group does not mean app permissions are granted; do not auto-modify platform permissions and do not require lark-cli. Chinese and English replies match; `/disable` carries no enable guide. Real scenarios are verified manually by the user; dev is not started.

## Default history and execution precondition (current rule)

Groups without `historyEnabled` default to enabled; explicit false is preserved. Topic-history reading is an execution precondition: missing permission, missing read API, or read failure creates no task, submits no input, advances no checkpoint, and never degrades to reference-only. When explicitly off, prompt `/history on` and pause topic execution; group main chat, private chat, and control commands keep their behavior. This rule replaces the older history-gap-degradation and default-off records.

```text
first access/gap recovery -> history switch -> native thread history read (checked even for the root message's first send)
                     ├ success -> material prep -> CLI intake -> checkpoint
                     ├ missing permission -> admin grant guide, no execution
                     └ transient failure -> retry hint, no execution
```

Permission errors stay typed; a plain network failure is never reported as missing permission. Admins check app-identity message permissions (especially im:message.group_msg) in the Feishu/Lark app's permission management, publish, and @ again; no lark-cli and no automatic execution. Guide links point at the corresponding platform console. Official history API reference: https://open.feishu.cn/document/server-docs/im-v1/message/list . Limited history gaps after a successful explicit read are still marked via the attachment, never claimed complete.

Verification: 178 related unit tests, root typecheck, lint, verify:pre-push, and format checks pass. dev not started; real Feishu/Lark, mobile, and other OSes await manual user verification. In a group without explicitly disabled history, @ directly in the topic; missing permission must show only the grant guide with no new task, and execution starts only after permissions take effect. Main chat and private chat stay normal.

## Topic task isolation and migration

Every topic binds a standalone task, including topics created by a user replying to a bot main-chat message. The task is created only after the first trigger's materials are prepared; a joined topic keeps receiving human messages without repeated @. Old topicAliases migrate once, at a safety boundary, into standalone bindings — old task records are kept, the full context is not copied. After migration the alias runtime path is gone; existing standalone tasks keep their bindings.

New task title: 「飞书/Lark · 群名 · 话题标题」. User renames do not change the binding. Old tasks are not auto-renamed, no task-creation notification is sent, and no worktree is auto-created.

This spec replaces the old body-concatenation reference, auto-summary, and bot_topic_context injection. Group/topic authorization, task binding, the unique queue, cross-client recovery, and result push-back boundaries are preserved.

## Input and ordering

| Material | Existing mechanism |
| --- | --- |
| Message body | normal input |
| Explicit quoted text | standard conversation quote, carrying the real original |
| Explicit quoted image/file | normal attachment, fully prepared before submit |
| Topic history | reference long-paste mechanism generating a viewable text attachment |

```text
trusted inbound -> authorization, topic, and join-state checks -> body + quotes + attachment prep
         -> target runtime attachment staging -> CLI CommandInbox single intake
         -> on confirmation, save associations and advance the incremental checkpoint
```

Quotes reuse existing encoding and parsing; the UI restores the quote entry. Never show `[Quoted message]`, raw JSON, or bare IDs. A quote is not a command/approval. Over the existing quote capacity, reject the whole submission — never silently truncate.

## History format and reading

First collection covers the root message and the pre-@ discussion; afterwards only the increment after the last confirmed intake is fetched, and messages after the current @ wait for the next round. Deduplicate by message id; exclude this turn's body, explicit quotes, already-submitted inputs, bot results, and status cards. The automatic read cap stays at 200 related messages plus the first root message; gaps are recorded, full history is never promised. On a history-API failure, only a gap-explanation attachment is generated; even if that input is accepted, the history-read checkpoint does not advance, and the next @ resumes from the last successful, confirmed read position.

UTF-8 `.txt` format version 1: topic name, message count, covered start/end time and timezone, and a completeness note; messages M1, M2, ... listed by time, each with sender name (when available), open_id, time, reply linkage, and the original text with line breaks. History images/files list name, type, resource references A1, A2, ... and the not-yet-read status — no embedded binaries. The UI shows 「话题历史 · N 条消息」. No duplicate attachment when there is no increment and no gap.

History uses a dedicated topic-history source marker and reuses the paste-attachment lifecycle, exempt from the long-paste character threshold. The model gets the file reference first; content enters context only after an actual read — no full-text auto-injection, no eager model summarization. Long-file segmented reading and later compaction reuse existing capabilities. The full text never coexists in the body and a hidden model message.

## History attachments

Each history file's M1/A1 indexes resolve against that file's identity; the server maps real group, topic, message, resource, and authorization version, never mixing across turns. Names, ids, and file bodies are never an authorization source. Explicitly quoted attachments are downloaded this turn and submitted as V4 attachments, with no Host path note appended. Keep the limits of at most 4 attachments per message and 5 MB each; over-count, over-size, or unavailable resources reject the whole message — never take the first few and continue. Other history attachments are read on demand through built-in capabilities, re-validating access scope each time. No lark-cli dependency and no extra lark-im loading or re-scan to read the current bot session's materials.

## Queue, display, and compatibility

Group inputs stack top-to-bottom as 「sender → conversation quote → images/files and history attachments → user body」, right-aligned, reusing the existing 8px spacing and quote/attachment components. Desktop and mobile share this order; normal desktop input material order stays compatible. An @ with no body but with quotes or fresh history material submits the materials themselves — never fabricates a “请回答引用消息……” instruction as user body — and leaves no empty bubble in the UI. An @ with no submittable material still prompts for the request. Old message bodies are never rewritten by string guessing or deletion.

A required-material failure rejects the whole message; optional history gaps are recorded in the attachment with no extra history-loading hint or content message. Generation and injection of bot_topic_context are stopped; old records stay readable but are not re-injected and user history is not deleted. The server keeps the original-text archive, checkpoints, and resource index for dedup and authorization — they are not hidden model context. The CLI source carries only the topicHistory checkpoint, coverage state, message count, and per-message id/resource counts — no full topicContext text — so no large command frame exists besides attachments; old topicContext sources stay readable. Text preview reuses attachment chunk reads: only text/plain attachments marked as topic history or pasted text in the current authoritative conversation row are allowed, still validating row identity, attachment index, and quotes — an arbitrary path is never a preview source. Source metadata flows through upload, command, queue, edit, execution, conversation, and recovery; attachments still referenced by a pending input are never cleaned early. On confirmation loss, query the original commandId and add no make-up command; an existing unconfirmed-intake record is never resubmitted or re-fetched for history, and new discussion in between is never written into the original input. Desktop keeps desktop-continuous; mobile keeps web-remote-replayable. Remotes carry workspaceIdentity and remoteSessionId, use target-accessible resources, and create no second Host/runtime or accepted queue.

## Acceptance order

Write failing tests first, then implement: quote round-trip and capacity; text-file name/id/original/time and coverage gaps; attachment index isolation; source marker across upload and queue recovery; no hidden injection; permission revocation; confirmation loss. Desktop/mobile check quote and attachment preview, queue, and history recovery. Run typecheck, lint, related unit tests and E2E, then verify material reading and on-topic results with real Feishu natural language; service doubles never impersonate real acceptance. Unverified Lark/remote/other-OS items are recorded explicitly.

## Display adjustment acceptance

Group result bodies send only the result — no Desktop, Mobile Web, name, or open_id prefix; source metadata stays for internal correlation. This ordering and source-label change uses real-scenario manual acceptance with no new or extended E2E. Check sender/quote/attachment/body order and no empty bubble on quote-only input, then submit a request from Desktop and confirm the Feishu reply has no source prefix.

## Real manual acceptance

First confirm the test bot's connection is held by this branch's `pnpm dev:desktop`; if another workspace's Dev holds it, old-version results do not count. The Feishu window is user-operated.

1. In the enabled test group, the bound user sends `@机器人 /history on`. In a new topic, post two discussion messages without @ and confirm no task executes.
2. Reply to one text message and @ the bot, asking it to answer using the other discussion. The body shows only this request; the quote entry opens the real original; the history file contains only background not quoted this time.
3. Send another plain discussion, then @ the bot. The new history attachment contains only the increment; opening shows names, open_id, original line breaks, and the coverage note. No duplicate attachment when there is no increment.
4. Upload a local test txt, reply to it and @ asking to read the checksum. ZCode must show a normal file attachment, the body has no local cache-path note, and reading needs no lark-cli authorization.
5. Send another image or file normally, then @ separately asking to analyze that history attachment. The history txt lists the resource index; the built-in ReadSessionContext reads on demand; no cross-topic reads and no scan required.
6. After editing/send-now on a Desktop queued item, confirm quotes and attachments persist. Mobile remote control connects to the same Host and is verified separately for preview and recovery; a narrow window never replaces the real mobile chain.

Local test files: `/tmp/zcode-topic-materials-20260908.txt` (independent checksum, multi-line) and a separate `/tmp/zcode-topic-history-resource-20260908.txt` with a different checksum, so reading the earlier quoted attachment is not mistaken for a history-resource read. Dev acceptance only; not a product runtime dependency.

## Verification record (2026-09-08)

- Desktop controlled integration `feishu-topic-runtime.test.ts` passes: quote/file enqueueing, cancel, history material dequeue on a real Host/CLI, and original-text preview at 1280/430 widths. Materials are fixed test inputs, not native Feishu history-API acceptance. Real runs exposed and fixed group files still concatenating old paths, conversation-row schema stripping attachment sources, and preview allowing only media types; failing tests plus post-fix checks are kept.
- Typecheck, root lint, changed-Agent-file lint, verify:pre-push, and staged-format checks pass; group-service/history 64, attachment-read runtime 30, and preview-response protocol 11 tests pass. History-API failure not advancing the checkpoint has a regression assertion.
- The old `session-persistence.test.ts` did not pass when extended (model double lacked `setModelIoFullRetentionEnabled`, unhandled MCP startup-probe exception); the unrelated fix was not taken, and this round's artifact reading uses `text-attachment-preview.test.ts` with unrelated MCP startup disabled.
- Open: native Feishu manual input, real mobile remote control, Lark, and Windows/Linux remain unverified; narrow-window or controlled-material results never replace them.

### Card quote original-text fix

When quoting a bot Card 2.0 message, fetching that message must pass `card_msg_content_type=user_card_content` and then extract the visible body; the client-upgrade placeholder returned by default is not the original. The root cause was confirmed by both request shapes against the same real message. History keeps only the type marker for cards — this change does not widen historical card content; card approval identity checks and attachment resource reads keep their semantics. Manual acceptance: reply to a bot card and @, then open the ZCode conversation quote — it must show the card's real body. Fix record: the provider case failed on the placeholder before and 82 provider unit tests pass after; a read-only fetch through the fixed `prepareCallbackPayload` resolved the 2026-09-09 10:32:44 timed body without submitting or sending anything. Typecheck and lint pass; end-to-end UI acceptance after the user re-quotes awaits confirmation; no E2E run.

## Structured conversation quotes

New input uses an optional `conversationQuotes` array alongside body and attachments; each entry has `text`, optional `path`, `senderName`, `senderId`, `messageId`, `sentAt`. External sender metadata is injected only by the access layer from the message-read result and is never an authorization basis. When a name is unavailable, show a shortened stable id; bots prefer the bot name. Expanded quotes show sender and time; collapsed shows the quote count.

The fields pass verbatim through command → CLI CommandInbox intent → transcript → row/queue projection; edit, promote, recover, and retry never lose them. Quote-only is a valid input. Model input converts to `conversation_quote` material blocks at the Agent boundary, explicitly reference background rather than control commands; user body and persisted visible body get no concatenated labels. Old `userselect` and Conversation selections text blocks keep parsing; old records are not migrated or rewritten. Desktop continuous and mobile replayable keep their boundaries; workspace identity and owner routing are unchanged.

Manual acceptance: correct name/time/original when quoting human text and bot cards; desktop text-selection first send and follow-ups; quote-only, queued edit/send-now, history recovery; the model receives originals and sources with no new `userselect`; light/dark themes and narrow screens. Real mobile/Lark stay explicitly pending when unverified.

## Superseded history: 2026-09-09 history prep and push-back fix

The default-off, off-degradation, and per-@ behaviors recorded then are replaced by the current rule above and are not manual-acceptance steps. Still-valid outcomes from that round: history textContent persists as an artifact via the target CLI's existing begin/chunk/commit, and sendText is created only after upload completes — no separate local history cache; an upload failure submits nothing, and remote targets keep workspaceIdentity/remoteSessionId. The model boundary adds a note for trusted botGroupSource that normal replies are auto-delivered by the service — the original message id is not a send task; extra sends happen only on explicit user request via the communication skill. Quote identity only marks provenance; missing prerequisites (like a location) must be asked for, never guessed from contacts, IP, or machine timezone. That note contains no history originals and does not restore bot_topic_context; quotes and history keep the existing material channels. Attachment storage uses the target CLI's session artifacts: after full validation, `writePromptAttachment` writes into the session artifact and returns a `zcode-artifact://` reference — not a standalone `topic-history.txt` in the workspace root; ZCode reads real content through the existing attachment preview. Automation then: root typecheck, lint (43 pre-existing warnings, 0 errors), verify:pre-push pass; 188 root tests, 188 projection/cold-recovery tests, 59 queue/edit-retry tests, 5 core quote/persistence tests, and 2 model-material display isolation tests pass; the Agent full-package standalone lint still has pre-existing max-lines files and is not claimed as passing. dev not started; no real Feishu, Lark, mobile, or other-OS manual acceptance that round.
