# M5 Composer Parity: Full Alignment of the Input Box With the Old Version, Capability Audit

Principle: **old shell, new core**. The old `ChatViewComposer` / `ChatPromptEditor` / `ChatInputToolbar`
JSX/styles are reused as is (z-code-2 reference); all wiring is new. Data is read from the v4 projection
(`snapshot.inputRouting / control / config / usage`) + sessions-index + the live config-surface services.
Operations send v4 commands (`sendText / createSession / editUserQuery / stop / switchModelConfig /
switchCollaborationMode / attachment.put`). Old hook orchestration and old store session state are not revived.

Reference baseline: old `ChatViewComposer.tsx` (before deletion, `b44d4a87a^`). Current carriers:
`packages/ui/src/v4/ConversationComposer.tsx`, `packages/ui/src/v4/composer/*`,
`packages/ui/src/v4/SessionPane.tsx`.

Full history: `git show b8876e8b:docs/v4-refactor/m5-composer-parity.md`

## 1. Aligned capabilities (capability: v4 carrier, status)

- Lexical editor + action menu + sticky base: same `ChatPromptEditor` component. Done.
- Dynamic placeholder (phase/history wording): same `resolveChatPlaceholderKey`;
  `hasHistoryMessages=rows.totalCount>0`, `isTaskProcessing=control.canStop`. Done.
- Enter submit policy: `resolveChatEnterSubmits(preferEnterNewline=isWebRemoteControl)`; desktop Enter sends,
  mobile Web remote Enter inserts a newline (§3). Done.
- Per-session draft persistence: `composer/composerDraftStore.ts` (independent v4 key space, text +
  editorStateJson, scope = sessionId / `__draft__`; does not write the old keys). Done.
- Prompt history up/down: `readPromptHistoryEntries` / `appendPromptHistoryEntry` / `persistPromptHistoryEntries`;
  writes only filter a consecutive duplicate equal (after trim) to the previous entry, old history is not
  cleaned on read (see `docs/ui/composer-prompt-history.md`). Done.
- Attachments, all done: file picker (native picker / hidden input fallback) `useComposerAttachments.openAttachmentPicker`;
  pasted image/file `handlePaste`; long text paste >= 15Ki chars -> host temp file via
  `platform.createTempTextAttachment`; external OS drag with heartbeat auto-reset
  (`handleDragOver/Leave/Drop` + `scheduleComposerDragFeedbackReset`); whiteboard add-to-chat (PNG)
  `handleWhiteboardMentionSelected` + `WHITEBOARD_ADD_TO_CHAT_EVENT`; limit 8 / size / oversized inline image
  refusal (`MAX_CHAT_ATTACHMENTS` + `serializeForSend`; `OversizedInlineImageAttachmentError` refuses the
  send and keeps the draft); objectUrl reclamation on unmount/clear (`revokeChatComposerAttachment`);
  preview grid + large image preview (`topContentNode`, old 345-501 section restored as is).
- codeComment attachment chip: `useCodeCommentContexts` (composer in-memory state) +
  `buildPromptWithCodeComments`; only the primary pane receives the global event; after a successful send the
  code preview is removed too. Done (bugfix 2026-07-21: restored the add/remove events, chip and send
  serialization missed in the V4 migration).
- webElementContext attachment chip: `useWebElementContexts` (composer in-memory) +
  `buildPromptWithWebElementContexts`; after sending, the user row restores a read-only chip with
  `parsePromptWebElementContexts`, copy/edit keep the original `row.text`. Done (2026-07-09): not a protocol
  attachment, not in draft persistence.
- Session error banner above the input: `SessionPane` reads `snapshot.control.lastError`, maps it to
  `ChatErrorBanner` above the `ConversationComposer` editor; dismiss hides only the current error
  fingerprint, the next error still shows. Wired (2026-07-07).
- Attachment send, deposit -> reference model: `attachment.put` -> `AttachmentRef`
  (`composer/attachmentUpload.ts`, 10 §6.5); localPath zero-upload, inline images through put. Done (new protocol).
- Mentions: `@` file/folder (`enableMentionPanel` + `fileService.listWorkspaceFiles`), `@` whiteboard
  (`onWhiteboardMentionSelected`), `$` skills (`skillsService`), `#` sessions (`sessionsMentionProvider`
  switched to v4 sessions-index via `useWorkspaceSessionsIndexItems`). Done.
- Slash `/` catalog: commands show only the CLI workspace slash catalog; skills and subagents keep their own
  catalogs; the UI adds no command and keeps no built-in whitelist. Done.
- Unrecognized `/` command sent straight to the CLI: not consumed when attachments or web element context are
  carried; `text.startsWith("/")` without context attachments goes through `handleSlashCommand`, unrecognized
  ones are sent via sendText. Done.
- Workspace file tree "add to chat": `WORKSPACE_FILE_ADD_TO_CHAT_EVENT` -> `appendWorkspaceFileMentionToComposer`
  (primary pane only). Done.
- Send / stop / queue state machine: `canSend` / `showStopControl` / `mode==="choice"` two buttons, reading
  `inputRouting.mode` + `control.canStop`; the streaming queue send button maps to the v4 `choice` mode
  (clear queue / keep queue and send now). Done.
- Esc -> stop generation (no accidental stop inside dialogs): `composer/escapeStop.ts` + `SessionPane` window
  keydown (primary pane only, gated by `control.canStop`) -> `stop`. Done.
- Toolbar model / thought depth / mode / context usage: `V4ComposerToolbar` (presentational parts reuse the
  old chat-input-toolbar; values read from config, writes send v4 commands). Done.
- Toolbar hotkeys Ctrl+M / Ctrl+Shift+M / Ctrl+T: `composer/toolbarShortcuts.ts` (pure logic); Ctrl+M ->
  openRequestKey opens the menu, Ctrl+T -> `getNextThoughtLevelValue` -> switchModelConfig, Ctrl+Shift+M ->
  `getNextConfigSelectValue` -> switchCollaborationMode. Done.
- queue behavior toggles autoDrain / followupMode (v4-specific): `V4ComposerQueueToggles` (reuses the M4
  input-control testid). Done.

### codeComment add-to-chat chain

The code preview and the composer stay decoupled through a cancelable renderer event; no protocol field is
added. Only a primary pane with `listenAddToChatEvents=true` may claim the event, so a click in split view
writes into one input area; a comment keeps its own `workspaceIdentity`, and removal matches exactly on
"source workspace key + comment id".

```text
code preview submits a comment
  -> CODE_COMMENT_ADD_TO_CHAT_EVENT
  -> primary V4 composer claim
  -> codeComment chip + sendable state
  -> buildPromptWithCodeComments
  -> sendText (still plain text)
  -> after accepted, clear the chip and remove the source code preview
```

If the send is `blocked`, needs queue confirmation, or throws, the chip and code preview are kept so the user
can retry. The chain changes only renderer draft content; it does not change the delivery, snapshot, queue or
owner boundaries of desktop `desktop-continuous` and mobile `web-remote-replayable`.

## 2. In the old version, not wired in v4 (disposition and reason)

- Context compression guard before a model switch (`onRequestContextCompressionForModelSwitch`,
  `modelSwitchContextWindowGuard.ts`): not revived, module deleted with the wave; the `/compact` entry of the
  context-usage panel remains (`onSendCompressionCommand`).
- Provider recovery (`onRecoverWorkspaceProvider`, recovery config surface): not wired until the
  config/recovery surface is v4-ized; not part of the session input core.
- `contextHeaderContent` (header banner slot): no v4 header content source; pure display slot, wire on demand.
- `onFocus` (`handleInputFocus`): used to clear blocking/focus side effects; the v4 permission surface is
  gated by `inputRouting.mode`, not by composer focus.
- `blockingRequestId` hiding the whole composer (`display:none`): replaced by `inputRouting.mode` gating
  (reject -> editing disabled, guide/choice -> no direct send); equivalent semantics.
- `triggerPanelContainer` external portal: `ChatPromptEditor` has a built-in fallback
  (`internalTriggerPanelContainer`); equivalent, done.

## 3. Enter submit policy

The only source of the old `preferEnterNewline` is `isWebRemoteControl`, not a user setting. Desktop:
`preferEnterNewline=false`, Enter sends, Shift+Enter inserts a newline. Mobile Web remote: `true`, Enter
inserts a newline and the send button submits. The v4 composer keeps computing it through
`resolveChatEnterSubmits`, passing `isWebRemoteControl` as `preferEnterNewline`; the mobile viewport gate stays
in that function and mobile semantics must not leak to desktop.

## 4. Conclusion

The core input capabilities (editor / draft / prompt history / full attachment chain / mention / slash /
send-stop state machine / Esc-stop / toolbar + hotkeys / dynamic placeholder / Enter policy) are fully aligned
with the old version. Unwired items are either **beyond the v4 vertical slice** (code review / provider
recovery) or **ruled dead** (model-switch compression guard), not omissions.

**Erratum (2026-07-07):** the audit above covered only the composer for an existing session. The **draft state
(sessionId=null) was missed entirely**; that is a real omission outside the "not omissions" conclusion. The
follow-up audit is §5.

## 5. Draft state (draft / empty state) reconciliation (follow-up audit 2026-07-07)

Reference baseline: z-code-2 online `ChatView.tsx` draft path (`shouldShowChatViewEmptyState` /
`shouldUseCenteredDraftChatLayout` branches) + `ChatInputToolbar.tsx` (`taskId=null` branch). v4 carriers:
`SessionPane` (`sessionId===null` -> `draftMode`), `ConversationComposer`, `V4ComposerToolbar`.

Root cause: the three v4 toolbar controls (model / thought depth / mode) were all gated on `config !== null`,
which only comes from the session projection `snapshot.config`; a draft has no projection, so the controls
did not render, and the write path `dispatchConfigCas` skipped when `!sessionId`. The empty-state shell
(workspace menu / greeting / centered layout) was not wired at all.

### 5.1 Toolbar config surface (draft state)

Unified scheme (paired with 10-protocol-spec §4.2.3 R-19): **a draft reads and writes the workspace default
config, and the first send carries it in `createSession.config`.**

- Read: `currentValue` of `useToolbarConfigOptions(workspacePath, null, workspaceIdentity)` (= workspace
  default, live config-surface service; the consumer stays unchanged when it later switches to the v4
  `workspace-config` topic).
- Catalog hydration (second-test ruling 2026-07-07): after the old `useWorkspacePrepare` hook was deleted with
  M5(2), nobody initialized the draft catalog (always empty -> controls hidden, agent not started -> first
  default write failed). Hydration is owned by the mount effect of `useDraftConfigControl`: when the catalog
  is missing, `readWorkspaceState` fetches it and writes the store (per-workspace single-flight; also starts the
  workspace agent). During hydration the model menu stays visible with a placeholder trigger (clickable once
  the app provider snapshot grouping is ready).
- Catalog readiness boundary (bugfix 2026-07-21): `configOptions` and `slashCommands` are two independent
  catalogs; "the model catalog exists" must not stand for both being hydrated. task -> draft inherits the
  model catalog but clears the previous session's slash commands; an empty slash catalog then must retrigger
  the same `readWorkspaceState` single-flight and write back to the current workspace identity bucket by
  `workspaceIdentity?.trim() || workspacePath`.

  ```text
  task -> draft
      ├─ configOptions: kept ───────┐
      └─ slashCommands: cleared ───┼─ either catalog not ready -> readWorkspaceState
                                    └─ both ready -> skip RPC
  ```

  This only fills renderer draft catalog hydration; it does not change the delivery, snapshot, queue or owner
  boundaries of desktop continuous or web remote replayable.

- Known-session navigation boundary (bugfix 2026-07-22): `slashCommands` is a workspace-identity-level
  catalog; selecting an existing task of the same workspace must not clear it and wait for the conversation
  projection to backfill (the projection only restores session state, not the workspace catalog the composer
  consumes). If a cold recovery or old state really leaves it empty, `useDraftConfigControl` reads workspace
  state independently under an existing session, without overwriting the task config or applying the draft's
  global model seed to that session.

  ```text
  draft / task A: workspace slash catalog ready
        │ select known task B (same workspace identity)
        ├─ catalog non-empty ──> kept as is, composer usable at once
        └─ catalog empty ──> readWorkspaceState ──> fill the workspace catalog
  ```

- Command catalog authority (2026-07-22): the CLI protocol workspace slash catalog is the only source of
  commands. The UI removes the M5 migration-period `extraSlashCommands`, the built-in whitelist and the GLM
  `/goal` fallback; `/goal`, `/compact`, `/init` and custom commands follow what the CLI returns. The
  UI-private `/resume-goal` alias is removed; resuming a goal uses the CLI-declared `/goal resume`. The submit
  boundary keeps command routing but no longer declares the catalog.
- Write: reuse the live `lib/zcodeWorkspaceDefaultConfigControl.ts` (writes the workspace default, so "the next
  new session inherits the last choice"; an online bug of writing only the draft and not the default was fixed,
  comments preserved).
- First send: `createSession` carries `config` (partial, already supported by protocol `command.ts`); the CLI
  merges the initial session value per R-19 from the runtime truth + requested config; the UI no longer relies
  on "create the session first, then switch config".

Capability status (all done 2026-07-07 unless noted):
- Draft model selection (shows workspace default, switchable): `resolveDraftEffectiveConfig`
  (composer/draftWorkspaceDefaults) composes a display-only config.
- Draft mode selection: `resolveDraftModeCurrentValue` + `V4ComposerModeSwitch` draftMode branch.
- Draft thought depth: thought catalog currentValue fallback (same effectiveConfig).
- Draft choices write the workspace default (dual semantics: current first send + new-session inheritance):
  `useDraftConfigControl` (writes default + authoritative catalog written straight to the store for echo) +
  `createSession.config` carrying.
- Toolbar hotkeys in draft state: recover naturally once effectiveConfig is non-empty; e2e assertion pending (§5.6).
- Non-empty toolbar initial values after the session is created: CLI R-19 seed landed (c7ee7b914).

### 5.2 Empty-state shell

All done 2026-07-07 except the last item.
- Workspace switch menu (search / up to 5 items / open folder / SSH remote entry / disconnected-remote filter):
  `ChatEmptyWorkspacePreviewMenu` (ChatEmptyState.tsx) reused as is; the shell (WorkspaceShellLayout) builds
  `draftComposerHeader` and passes it V4WorkspaceChatArea/V4ChatPane -> SessionPane -> composer contextHeader.
- Git branch switcher (empty state, popover locked upward): same path, `avoidPopoverCollisions=false` (old
  bugfix preserved).
- Time greeting + ZCode logo: restored as `v4/ConversationDraftEmptyState.tsx` (`compactForRemoteControl`
  prop converged into max-md responsive).
- Centered draft layout (composer vertically centered): SessionPane draft branch, greeting + composer
  (`centered`, max-w-2xl, no sticky).
- `TID_CHAT_EMPTY` e2e anchor: carried by the centered draft container.
- Scratch workspace entry (`ChatEmptyScratchWorkspaceDialog`): **not wired** (component alive; the old entry
  is not inside the menu component); pending, first confirm who owned the old trigger.

#### 5.2.1 Title position in low-height windows (2026-07-30)

1. Default height keeps the existing "greeting + composer dock" overall centering; the spacing between logo,
   title, composer, banner and templates is unchanged.
2. The draft content group uses a continuous safe-centering constraint: centered when there is room, stops
   moving up when not. Desktop windows keep the cross-page `480 x 640px` native floor; the renderer must not
   call `setMinimumSize` or `setBounds` from the draft DOM height (width changes cause localized re-wrapping,
   forming a `ResizeObserver -> IPC -> native window grows` feedback loop while dragging). Reserve `52px`
   above the title and `16px` below the last card; when the display or window cannot hold everything, the
   draft timeline scrolls itself. Do not hard-code the total window height from any current copy sample
   (`zh-CN`, `en-US`), and do not switch between two layouts at a fixed height breakpoint (the title, logo
   and composer would jump as a group when crossing it).
3. On default wide screens the greeting title, logo and composer dock share one horizontal center axis; the
   empty-state layout container must not make the greeting fall back to start alignment. Top and bottom use
   continuous flexible spacers: equal margins when space is ample, stopping at `52px` / `16px` floors when
   constrained; do not use two `1fr` grid tracks with different floors (it would wrongly lift the bottom to `52px`).
4. The greeting title stays `30px`; font size is not bound to window width, chat width or a fixed viewport
   breakpoint. Only when the title at `30px` really exceeds its own available horizontal width does it shrink
   by `1px` steps to a minimum of `20px`; with space on both sides it stays `30px` even at minimum window size.
   Measure on the real localized copy.
5. Title measurement and the `52px / 16px` safe spacing apply only to the desktop draft home. Mobile `/remote`
   keeps the original `20px` compact title and `justify-center + 16px gap` layout, so the desktop's decorative
   space and measurement logic do not spread into the mobile replayable UI.
6. The low-height constraint changes only the vertical start of the draft content group; the title-to-composer
   spacing is unchanged and overflow is taken by the existing timeline scroll container. The draft layout
   container keeps its intrinsic content height (no `h-full min-h-0 overflow-hidden` truncation). The desktop
   draft empty-state timeline always starts from the top so the existing bottom-sticking semantics do not
   scroll the safe top margin out of view; leaving the draft empty state restores session bottom-sticking.

### 5.3 Draft behavior

- Draft session prewarm (`draftSessionId`: pre-create a real session, reuse on first send): v4-native prewarm
  (§5.4, `useDraftSessionPrewarm`). **Wired (the 2026-07-07 fourth-test ruling reverses "do not revive")**: the
  original ruling threw away the old prewarm chain's patch baggage and the prewarm itself, forcing draft
  config onto the old workspace-default RPC (the reply `buildWorkspaceState` creates a full temporary app when
  no session is registered, 140-798 ms each). The three old patches stay dead in the v4 form (no object).
- Draft provider inheritance on workspace switch (the target workspace's remembered provider wins):
  `workspaceDraftProvider.ts` (alive); `App.handleStartDraftInWorkspace` already calls it and the
  empty-state menu `onSelectWorkspace` feeds that chain. Verified alive (2026-07-07), no new code.
- Provider recovery `onRecoverWorkspaceProvider`: stays per §2 (not wired until the config/recovery surface is v4-ized).

### 5.4 Draft state = v4 draft session prewarm (user ruling 2026-07-07 "key feature")

Target: **entering draft state creates a v4 draft session (`createSession` without firstInput -> phase=draft,
memory-only) which is the prewarm carrier**, consistent with 10 §4.2.1 "a pane bound to a draft session means
the server already has a session entity". Gains: zero-wait first send; config writes use native v4 CAS
commands (not the hot path of the old workspace-default RPC's buildWorkspaceState); the toolbar reads the
session projection (R-19 seed provides the runtime truth).

Implementation (`useDraftSessionPrewarm` + SessionPane wiring):

1. **Create.** When the pane has no session (sessionId=null), `createSession` runs in the background; an
   explicit split draft pane prewarms as an independent pane and keeps binding isolation. The owner of one
   logical draft is fixed as `{ workspaceKey, paneId, transportGeneration }`: remount or StrictMode effect
   replay within the same event loop reuses the same pending/ready prewarm and never enqueues another
   `createSession`; a remount after a real unmount waits for the old owner to retire if the old create is
   in flight. Model readiness belongs to this draft check lifecycle: entering the draft from a formal session
   starts as checking, never reusing an old ready to start prewarm and having an effect reclaim it. When
   re-entering the draft on the same path or switching the model catalog service, late results of the old
   check and the old first-send recheck must not overwrite the current check. When
   `draftRuntimeInvalidationVersion` changes repeatedly only the latest target generation is kept; if an old
   create is in flight, wait for its ACK, send cleanup, then create the latest generation; at most one
   `createSession` per owner is in flight at any time.
2. **Binding semantics unchanged.** The pane is still a draft outwardly (shell activeTaskId stays null;
   shell-level draft checks such as WorkspaceHeader are unaffected); the prewarm session is the pane-internal
   effectiveSessionId and lease/projection subscribe as usual. Draft UX (greeting / centering / workspace
   menu) stays keyed on pane sessionId===null.
3. **Single source of draft config intent.** Model, thought depth and mode are first written to the
   renderer's reactive draft intent and the toolbar echoes on the next frame; model and thought are one
   config tuple, and a cross-model switch must not inherit the source model's thought. Once prewarm is ready,
   only v4 CAS commands write that explicit sessionId's existing App. A draft click must not send
   `workspace/setDefaultModel|ThoughtLevel|Mode` nor wait for a workspace state broadcast to update the UI.
4. **Thought capability belongs to the target model.** While the draft intent is unbound, read provider
   metadata first; bound/historical/fork sessions must read `SessionConfigState.thoughtLevels`, projected
   atomically with `provider/model/thought` from the Agent runtime's `listThoughtLevels()` in one
   snapshot/event. Models like GLM-5.2 whose levels the CLI default policy fills dynamically must not rely on
   the legacy task config cache, borrow the source model's catalog, or fall back to the client's hard-coded
   generic five levels.
5. **Model remains available after fork.** After a fork creates a child session, the child Composer must
   restore the parent's provider/model/options at the fork point from that session's
   `SessionConfigState.modelSelection`. The first open of the child must not show an empty "Choose model"
   state or disable sending; if an existing child Composer draft lacks the model selection, fill it from the
   child session's authoritative config even if an earlier snapshot already initialized mode. If the user has
   chosen a model meanwhile, a late snapshot must not overwrite it. The renderer's session-scoped Composer
   draft is the sole owner of local selection; the snapshot only provides initial values. Event order: fork
   accepted -> partial child config -> draft initialization -> full child config -> fill the missing
   `modelSelection` -> send. E2E compares provider/model before and after fork and confirms the child's send
   request uses the inherited model.
6. **Projection confirmation and persistence.** The prewarm projection only confirms the runtime's actual
   config; only after the projection matches the latest intent's provider/model (and explicit thought) is the
   model + thought tuple persisted as a whole. A late projection must not overwrite a newer draft intent.
   While prewarm is not ready the intent rides `createSession.config`; after ready only still-inconsistent
   fields are re-projected.
7. **Order and merging.** Config commands and the first send share one ordering barrier; sending waits for
   the latest intent to converge. Rapid successive selections may merge intermediate values that have not
   started and sync only the last intent, never replaying old values one by one.
8. **First send.** `sendText` goes straight to the prewarm session (attachments upload to it via
   `attachment/begin -> chunk -> commit`, no more "create an empty session first, then upload"); on success
   the pane formally binds via onSessionCreated. Before issuing the first admission command, the renderer must
   mark the original binding `promotion-pending` synchronously; after ACK accepted it becomes `promoted`; an
   explicit rejection or invalidation makes it `discarded`. MCP initialization, hooks or transport
   backpressure can let the Agent start running while the renderer still waits for the ACK, so owner cleanup
   must not delete that session as an unused draft in that window.
   **Single creation owner correction (2026-09-15):** the first send waits on the current creation task of
   the same prewarm owner and must not treat `binding === null` as "not created" and send another
   `createSession`. Plain text, attachments, shared context and `/goal` share this entry; config is
   initialized at creation and the first send carries the Submission frozen at click time. On creation
   failure the submission fails and keeps the draft; bounded background retries and explicit user retry stay
   with the original owner, with no send-side creation entry. If workspace, transport or invalidation
   changes, or a real unmount happens during the wait, the old submission must not send to a new session.
   If the first-admission result is unknown, keep the original binding's pending lifecycle; never auto-resend
   on another session. When a new draft subscription is established while the old create is still retiring,
   the first send waits for the old create to close, then the new subscription's create; retiring itself is
   not a user switch. Wait eligibility is validated by the draft subscription lifecycle identity, not by
   invalidationVersion alone: even with the same version, leaving and re-entering must not continue an old
   submission. A real leave or workspace/transport/version change during any wait invalidates the submission.

   ```mermaid
   sequenceDiagram
     participant D as draft prewarm owner
     participant S as click send
     participant C as CLI
     D->>C: createSession (sole creation)
     S->>D: wait for the current creation task
     C-->>D: session A
     D-->>S: same-generation binding A
     S->>C: sendText / goal (A, frozen Submission)
     C-->>S: accepted
     S->>D: promote A, bind detail page
   ```

   Regression coverage: click send during a delayed create ACK, only one createSession before the ACK is
   released and the first admission targets the same session after; covers plain text, attachment/context,
   goal, failure, generation change and synchronous remount. Desktop continuous and mobile shared-host
   replayable both reuse the UI owner; Host/runtime, accepted input queue and stream recovery boundaries are
   unchanged.
9. **Cleanup.** Leaving without a first send (selecting another task / switching workspace / closing split /
   unmount) -> `deleteSession` the prewarm session; effect cleanup first gives a same-owner synchronous remount
   a chance to take over, and cleans up only after a confirmed real leave. Only a prewarm session still in
   `draft` may be auto-deleted; `promotion-pending`, `promoted`, `discarded` must never get a cleanup
   `deleteSession`, so an admitted or unknown-result runtime is not closed. A `createSession` already sent
   cannot be cancelled: the owner stays retiring until the ACK arrives and the delete is enqueued; a new
   owner must not bypass it and create concurrently. Orphans from a renderer refresh without cleanup vanish
   with the CLI exit (memory state); acceptable.
10. **Workspace / transport ownership.** The prewarm resource is not a bare cross-workspace-reusable
    `sessionId` but a binding `{ workspaceKey, paneId, transportGeneration, sessionId, controller,
    dispatchCommand }` owned by one owner. `workspaceKey` is `workspaceIdentity?.trim() || workspacePath`;
    transport generation is distinguished by the `SessionDataLayer` identity held by the workspace connection
    registry; a new `sendCommand` function from a provider wrapper rebuild must not be mistaken for a new
    generation. Within a workspace a lease change only updates the binding's lease and does not rebuild
    prewarm; on a workspace or transport generation change the new render stops exposing the old binding at
    once, and the old binding's cleanup may delete the old session only through the dispatcher that created
    it. Async closures (first-send ACK, subscribe failure) must capture and act on the original binding, never
    via `controllerRef.current` or a global mutable dispatcher. This applies equally to local, SSH/WSL/Docker
    and Web shared-host attachment, with no remote special case or separate runtime.
11. **List isolation.** The CLI gateway's `isDraftSession` (persistence=deferred) excludes drafts from the
    sessions-index at both fanOutToIndex and the cold-start seed, so a prewarm session does not leak into the
    sidebar as a "new task".
12. **Degradation chain.** While prewarm fails or is not ready, the toolbar falls back to the workspace
    catalog currentValue (§5.1 provides only the model catalog/capabilities; the current selection still
    follows the renderer draft intent) and interaction is not blocked.

State and sync order of draft config:

```text
toolbar click
  -> renderer draft intent (immediate echo)
  -> explicit prewarm sessionId
  -> v4 switchModelConfig | switchCollaborationMode
  -> CLI existing App
  -> projection confirms actual config
  -> persist confirmed model + thought tuple

first send
  -> seal/flush config intent
  -> sendText
```

`workspace/setDefault*` is a compatibility interface of the workspace catalog and not part of the v4 draft
interaction chain. Even if other old entries still call it, it must not serve a config click by "creating a
full temporary App, loading plugin/MCP, mapping state and closing at once".

#### 5.4.1 Composer continuity on first-send promotion (2026-07-10)

When a draft's first send promotes from `sessionId=null` to a formal session, `ConversationComposer` must keep
the same React instance and editor DOM, not unmount and rebuild because the draft centered container and the
session timeline bottom dock use different parents. Draft and session share one persistently mounted
conversation viewport: in draft the layout only centers the greeting and composer; after binding the layout
only moves the same composer to the bottom dock. No displacement animation is added.

```text
draft centered viewport
  -> send accepted / sessionId bound
  -> snapshot pending: blank timeline + same visible disabled composer
  -> first userInput projection: normal timeline + same composer dock
```

- Until the first snapshot / `userInput` row arrives after binding, the timeline content area stays blank; it
  does not show "send the first message to start" and the UI does not fake an optimistic user row.
- A formal session that exists but has empty rows likewise uses a blank timeline + bottom composer.
- The composer still clears after command ACK accepted; promotion must capture and clean the draft scope at
  send start, so the first input does not remain after the scope moves from `__draft__` to sessionId and
  reappear on the next new task.
- A subscribe error keeps its independent error layout; this section constrains only normal draft -> session promotion.
- Desktop and mobile Web share the same component identity and responsive layout; the projection delivery
  boundaries of `desktop-continuous` / `web-remote-replayable` are unchanged.

### 5.5 Model-switch recording semantics (fifth-test ruling 2026-07-07)

Ruling: **a switch action is an intention, not a timeline fact.** A draft that has not yet sent a message (a
[modelChange] hung above the first message was seen in sess_54392f61) and a switch during editing are both
preparation, not entering the timeline; only when the model differs from the previous turn after sending is it recorded.

- **Marker timing** (CLI projection, spec 10 §config "R-17 timing details"): the `modelChange` marker is
  decided in onTurnStarted by "this turn's provider/model identity != the previously started turn's
  provider/model identity". Thought depth only updates `config.thought` and request parameters and produces no
  `modelChange`. The marker lands before the new turn's turnHeader row; the first turn (no previous baseline)
  never produces a marker; A->B->A with zero net change produces none. onModelSelected only updates config and
  no longer lands a marker (the old implementation landed it at the selection event, the root cause of the
  draft-state bug).
- **Marker wording identity** (2026-07-29): the CLI marker carries start/end provider/model IDs; the renderer
  must subscribe to the provider snapshot and map provider names. Built-in Z.ai / BigModel providers show only
  modelId; other providers show `provider.name/modelId`, falling back to the provider ID when config is
  missing. Same rule as the model trigger and toast; marker schema, placement and the desktop
  continuous / mobile replayable semantics are unchanged; already-rendered markers must refresh the name in
  place when the catalog hydrates later or a provider is renamed.
- **Toast = performance-degradation warning, not a switch confirmation** (updated 2026-07-29, replacing the
  2026-07-07 sixth-test correction; draft boundary tightened 2026-07-30): only an explicit `provider + model`
  identity switch in a bound session shows the changed + warning text immediately; ordinary draft selection,
  configOptions-error custom-provider recovery and prewarm fallback never show a toast. The prompt does not
  wait for the switch ACK nor mean the command succeeded. An Agent registry automatic fallback reuses the same
  text when the focused pane of a bound session first observes an authoritative A->B jump with a source via a
  live `online` frame; draft prewarm, initial/recovery, historical snapshot, the full online snapshot that
  establishes the first applied base, duplicate deltas and background panes do not prompt. The automatic
  fallback's last-selected CAS happens only together with this live callback; ordinary snapshot differences
  must not write it. The UI writes no timeline row in either state; marker timing follows the previous item.
  The current full decision chain is in `docs/chat/manual-model-switch-resolution-chain.md`.
- **Replay determinism**: the marker is derived deterministically from the event sequence (ModelSelected +
  TurnStarted); cold recovery/fork replay use the same rule; transcript hydration does not synthesize a
  modelChange marker, so there is no history migration problem.

### 5.6 Acceptance

- e2e: in draft the model / mode / thought controls are visible with values = workspace default; switching the
  model in draft -> the new session's first projection `config` equals the chosen value (via
  `createSession.config` + R-19 seed merge); the empty state shows the workspace menu / greeting / centered
  layout anchors.
- Coverage matrix: per repo rules, first extend `docs/conversation-session-case-catalog.md` and
  `docs/testing/conversation-session-e2e-coverage-matrix.md`, then write the case.

## 6. context usage panel reconciliation (seventh review 2026-07-07)

Update 2026-07-09: a refactor added a `contextCapacityTokens` derived branch to `ChatContextUsage`, so with
only a model window and zero real usage a `0/max` ring was rendered, unlike the old version. The current rule
is restored: the context window shows only when `used > 0 && size > 0`. The Coding Plan / Start Plan balance
is independent of context usage but shows only after the "current model connection mode" is confirmed as
OAuth Coding Plan, Team Plan or Start Plan.

- Total row (used/size + percentage, compact token format): done via `snapshot.usage.contextWindow`; zero
  usage is no longer derived from model capacity.
- **Segmented bar + breakdown shares**: the old version shows 7 source classes (messages / system_prompt /
  meta_user_context / skills / tool_prompt / system_tool_schemas / mcp_tool_schemas) in descending share, only
  percentages and no per-item tokens (prevents mixed readings). v4 `SessionUsageState` has no `breakdown`
  field, so the component receives no data and does not render. **Wire**: the CLI `ModelComplete` payload
  already carries `contextUsageBreakdown` (core `turn-model-step.ts`, main_turn only) -> additive v4 schema +
  projection + UI pass-through.
- **Cache hit rate**: old version cumulative `cacheHit.hitRate` (main-turn aggregation,
  `recordMainTurnCacheHitUsage`), **shown only when >= 78%** (a low rate would pull attention from capacity).
  v4 `SessionUsageState` has no `cache` field. **Wire**: the payload `cacheHit.hitRate` exists; same
  three-layer wiring as breakdown.
- **Coding Plan usage panel** (`ChatCodingPlanUsageRemainingPanel`: multi-provider switch, remaining amount,
  click jumps to the settings usage page and closes the panel): done; the v4 toolbar wires
  `codingPlanUsageRemaining`, gated by current provider + family selected key; Team Plan supports an
  entitlement snapshot fallback source.
- **Start Plan balance panel** (zai/bigmodel: balance, loading, upgrade entry closes the panel before jumping
  to settings): done; the v4 toolbar wires `startPlanBalance`, keeping the Start fallback and current
  connection gating; hidden while a same-brand paid Coding plan is active.
- Trigger still shown with only plan data and no usage (draft/new session can see plan usage): done; shown
  only when the current connection is Coding/Team/Start and has a displayable balance or loading.
- `/compact` compression entry (`onSendCompressionCommand`): passed but the component **does not consume it**
  (dead parameter, `getContextCompressionCommand` has no JSX reference) in both versions; no gap, the dead
  parameter may be cleaned later.

Implementation batches:
1. **Phase 1 (usage data surface, pure three-layer pass-through)**:
   - `packages/shared/src/zcode-protocol-v4/snapshot.ts`: `sessionUsageStateSchema` additively gains
     `cache: { hitRate: number|null } | null` and `breakdown: ContextUsageBreakdownItem[] | null` (P-05
     conflation unchanged; the G-02 usage semantics extension must sync 10-protocol-spec §4.2.4).
   - CLI `product-projection.ts` `onModelComplete`: on main_turn merge `payload.cacheHit.hitRate` /
     `payload.contextUsageBreakdown` into the usage patch (keeping the old reducer ruling "only the main turn may overwrite").
   - UI `V4ComposerToolbar`: `taskUsage` passes `cache`/`breakdown` through (`ChatContextUsage` already consumes them).
2. **Phase 2 (plan panels)**: wired. If a hook is later extracted, the current connection gating, Team source
   fallback and Start fallback must be kept; do not regress to "show the balance whenever the account has a plan".
