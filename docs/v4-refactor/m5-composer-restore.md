# M5: v4 Session Composer Restore (Input Area Capability Closure)

## Goal

Restore the v4 SessionPane input area from the bare textarea of the M3 vertical slice to the full old-UI
capability: Lexical editor, mode selector, model selector, thought depth, context usage, send-key state
machine, `/` candidate panel. The capability audit is in `m5-composer-parity.md`.

Full history: `git show b8876e8b:docs/v4-refactor/m5-composer-restore.md`

## Old/new split (hard constraint: reuse the old UI, write the logic anew)

- `LexicalChatInput` (packages/ui/src/LexicalChatInput.tsx): restored as is from `b44d4a87a^`; the provider
  reads the live `v4/activeTaskProvider`; `ChatComposerPasteEvent` is closed in this file; the
  `enableMentionPanel` switch is kept; slash commands always read the CLI workspace catalog.
- `ChatPromptEditor` / `ChatPromptActionMenu` / `usePromptEditorDragState` (packages/ui/src/prompt-editor/):
  restored as is; pure-props presentational shell; passing through the `onSubmit` return value (false = keep
  the draft) is the only behavioral adaptation.
- `CatalogSlashCommandPlugin`: an early migration component, now deleted; the host static command catalog
  channel is retired and only `SlashCommandPlugin`, which reads the CLI workspace slash catalog, remains.
- `V4ComposerToolbar` (packages/ui/src/v4/composer/): new wiring; reuses the ModelConfigSelect /
  ChatModeSwitchControl / ThoughtLevelCycleControl / ChatContextUsage presentational parts; current values
  read v4 `snapshot.config` / `snapshot.usage`; writes go through v4 commands.
- `ConversationComposer` (packages/ui/src/v4/): fully rewritten; send-key state machine + held choice + Stop +
  dock layout.

## Data-plane wiring

- Model/thought -> `switchModelConfig`. The toolbar only raises semantic events
  `onSelectModel(providerId, modelId)` / `onSelectThought(thought)` (value decoded by `decodeCustomModelValue`);
  **command parameters are completed by SessionPane from snapshotRef (latest projection)**, because a memo
  child's config prop lags the projection by one beat during consecutive operations. CAS stale uses bounded
  retry on `ack.revisionAtDecision` (revision race of consecutive "switch model -> switch thought").
- Mode -> **new additive command `switchCollaborationMode`** (mode in build/edit/plan/yolo, CAS):
  - CLI handler (`commands/handlers/model-config.ts`): `app.getMode()` snapshot -> `app.setMode(mode)` ->
    `runtime.emitModeChanged` (new core method that emits `SessionModeChanged(source=command)`; `app.setMode`
    itself produces no event).
  - Projection: `onSessionModeChanged` -> `config.mode` (additive field with default `"build"`, old frames
    unaffected). `SessionModeChanged` from the plan tool path (enterPlanMode/exitPlanMode) is consumed too and
    the UI follows.
- context usage -> `snapshot.usage.contextWindow` (existing field, written at ModelComplete); the UI reuses
  ChatContextUsage (`{used: usedTokens, size: maxTokens}`).
- The model catalog (selector options) belongs to the config surface: read through live services
  (`useModelProviders` + `useToolbarConfigOptions(workspacePath, null)`); retires when the config surface is v4-ized.
- Send-key state machine (aligned with old ChatViewComposer): running + empty draft -> Stop (v4 `stop`,
  moved from the header into the composer); running + draft -> "add to queue"; held
  (inputRouting.mode=choice) -> clear/keep two buttons (M4 testid contract unchanged); pending -> spinner;
  a failed send keeps the draft.

## e2e contract

- `TID_V4_COMPOSER_INPUT` is a Lexical contenteditable: `setInputValueByTestIdDom` gains a
  `__zcodeLexicalInputE2E` bridge branch (drives real editor state; the Lexical update commits after a
  microtask, so writes are confirmed by polling); spec assertion semantics unchanged.
- Radix control driving: a controlled DropdownMenu trigger uses a real WebDriver click (element.click() has no
  pointerdown); Radix SelectItem confirmation ignores synthetic pointer gestures, so use "focus item + Enter"
  (the `selectRadixOption` helper) plus a menu-closed check.
- Observability: production renderer logs are off; v4 command ack summaries go to the bounded ring buffer
  `window.__zcodeV4CommandAcksE2E` (`v4/commandAckObservability.ts`), appended to spec failure reports.
- The M4 debug form (4 testids such as v4-model-provider-input) is retired; the `switchV4Model` helper drives
  `TID_CHAT_MODEL_SELECT_*` / `TID_CHAT_THOUGHT_LEVEL_SELECT_*` (real selectors).
- New `TID_CHAT_MODE_SELECT_TRIGGER/ITEM` (mode-select e2e anchors); the `TID_V4_MODEL_CONFIG` anchor gains
  data-mode / data-usage-used / data-usage-max.
- New spec `conversation-session-v4-composer-toolbar.test.ts` (slash panel appear/filter/select, model
  selector switching secondary, mode switch projection, non-zero usage projection).

## Open follow-up

During draft, the projected `config.mode` initial value is fixed at `"build"`; when the persisted preference is
not build, the first SessionModeChanged wins (TODO M6: a revision-free seed channel during draft).
