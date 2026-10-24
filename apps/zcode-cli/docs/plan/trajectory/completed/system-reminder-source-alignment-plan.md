# System Reminder Source/Content Implementation Plan

**Goal:** Without implementing user-message `content[]` merge / provider projection, fix the source, lifecycle, text semantics, delivery channel and test evidence of the ZCode CLI provider-visible `<system-reminder>`.

**Core boundary:** This is a system-reminder source/content plan, not a user-message restructuring plan. It may add source helpers, formatters, descriptors and source-level tests. It must not merge several user messages into one `content[]`, change the session store / UI transcript structure, or implement attachment bubble-up, cache-control finalization or provider request projection.

**Tech stack:** TypeScript, Vitest, `@zcode/core`, `@zcode/contracts`, `@zcode/adapters`, prompt-trajectory.

**Phase completion gate:** Every phase / round ends with a prompt-trajectory e2e run, inspecting `trajectory.jsonl` and the derived `*.openai_request_body.json` in the output directory. The e2e must include a targeted testcase / fixture that covers the round's change; running unrelated existing testcases is not acceptance. Acceptance is that the final provider-visible messages match the phase's expected content, order, structure and metadata stripping; source diff, unit tests or a clean runner exit alone are not enough. Prompt-trajectory reads built `dist` artifacts, so build the relevant packages (at least `@zcode/core`) first. If a dynamic behavior cannot be expressed by prompt-trajectory, record the specific runner gap in the phase and cover it with focused tests. Each phase stops after tests and code review for user confirmation before the next phase; no commit unless the user asks.

**Status:** Complete. SR0-SR12 are implemented with focused tests and prompt-trajectory evidence. ToolSearch/deferred tools, MCP instructions/resources, skill discovery, bubble-up, content merge and cache-control finalization stay independent or postponed; they are not unfinished items of this plan.

---

## Scope

In scope:

- Provider-visible system-reminder source taxonomy.
- Source owner, delivery channel, lifecycle, meta/source provenance.
- Reminder text semantics for features ZCode has or explicitly activates.
- `date_change` runtime-local behavior.
- System-reminder sources for Plan/target/Todo, hook, memory, skill listing, output style, tool-result warning, resume continuity and mid-turn system events.
- Inventory of attachment-origin system-reminder content and text for ZCode-supported types, without attachment order / bubble-up.
- Tests / prompt-trajectory evidence that a reminder exists or is absent, channel boundaries hold, and provider JSON does not leak internal descriptors.

Out of scope:

- User-message `content[]` merge; provider request projection / normalization.
- Cache-control finalization.
- Request-level `userContext` / instruction discovery.
- ToolSearch / deferred tools (P-13); MCP instructions/resources (P-14/P-15); skill discovery (P-27).
- Generalized attachment bubble-up / first-turn tail bubbling / attachment-before-prompt order (P-16).
- `task_reminder` cadence: ZCode has no producer, so no empty shell is added (Todo cadence is SR5; runtime_mode / plan mode content-cadence is SR9).
- Empty-shell reminders for sources ZCode has no feature for.

## Reminder source constraints

`<system-reminder>` is not one global string rule; it is produced by source-specific producers:

- The request-level userContext is a separate surface, not handled here.
- Attachment normalization, queued command normalization, tool-result helpers and Todo/task/date sources each produce reminders.
- Synthetic/provider-visible context carries `isMeta` / source semantics inside the runtime, but the final provider body carries none of these internal fields.
- Human queued input whose text looks like `<system-reminder>` is still user-authored content.
- Provider order, consecutive user-message merge, attachment bubble-up and cache-control happen at the API/provider normalization boundary and are not implemented here.

Implementation constraints:

- A reminder source is declared explicitly where it is created, never inferred from a `<system-reminder>` prefix of arbitrary user text.
- Source helpers may provide descriptors for a later content-merge plan, but this plan uses them only for source ownership, text and test evidence.
- If a later user-message provider projection consumes a source, the merge direction and serialization obey that separate plan: only synthetic/meta content merges forward into the following real user prompt; a reminder after the real prompt is never back-filled; a single text message is not forced into `content[]`.
- Provider-visible JSON contains only legal provider fields, never descriptor / provenance / evidence metadata.

## Delivery channel taxonomy

| Channel | Meaning | Examples |
| --- | --- | --- |
| `request_prefix` | Session/request-wide context before the conversation, not part of the current user prompt | skill listing, generic context prefix, later request-level userContext |
| `current_turn` | Dynamic context generated or re-sent for the current request | hook context, relevant memory, plan/auto mode, output_style, date_change, Todo reminder |
| `tool_result` | Context attached to tool result output | Read empty-file / short-read warnings |
| `history_continuity` | Context restored by resume / compact | restored todos, restored goal, post-compact continuity |
| `mid_turn_event` | System-origin notification during the tool loop / assistant turn | background task status, diagnostics, system queued notification |
| `real_user` | Real user input | queued human input, a user prompt starting with `<system-reminder>` (badcase) |

## Source descriptor contract

The descriptor is a core-local source contract, not a provider payload. It lives in the neutral module `packages/core/src/system-reminder/source.ts` so context/memory/tool code does not depend on a runtime helper; call sites reference this module directly (no runtime helper shim).

```ts
export type SystemReminderDeliveryChannel =
  | "request_prefix"
  | "current_turn"
  | "tool_result"
  | "history_continuity"
  | "mid_turn_event"
  | "real_user";

export type SystemReminderLifecycle =
  | "request_prefix"
  | "per_current_turn"
  | "runtime_local"
  | "tool_result"
  | "resume_history"
  | "mid_turn_event"
  | "real_user";

export type SystemReminderProviderVisibility =
  | "provider_visible"
  | "provider_hidden";

export type SystemReminderPrefixSource =
  | "context_prefix"
  | "skills_listing";

export type SystemReminderPersistedSource =
  | "todo_reminder"
  | "task_status"
  | "tool_result_warning"
  | "resume_todo_state"
  | "resume_goal_state"
  | "target_continuation"
  | "goal_completion_verification"
  | "rewind_notice"
  | "queued_system_notification";

export type SystemReminderPerRequestSource =
  | "hook_context"
  | "relevant_memory"
  | "runtime_mode"
  | "output_style"
  | "date_change"
  | "model_anomaly"
  | "prompt_attachment"
  | "diagnostics";

export type SystemReminderSource =
  | SystemReminderPrefixSource
  | SystemReminderPersistedSource
  | SystemReminderPerRequestSource;

export interface SystemReminderSourceDescriptor {
  source: SystemReminderSource;
  channel: SystemReminderDeliveryChannel;
  lifecycle: SystemReminderLifecycle;
  isMeta: boolean;
  providerVisibility: SystemReminderProviderVisibility;
  evidenceLabel: string;
}
```

Descriptor rules:

- `isMeta` / source ownership comes only from the call site or source helper, never from a string prefix.
- The `Prefix` bucket is request/context prefix sources; `Persisted` is sources that enter conversation history, tool-result history or the hydrate/replay boundary (not all are written by `persistSyntheticUserNoticeForSession(...)`); `PerRequest` is request-time / turn-local sources.
- A `real_user` source may start with `<system-reminder>` text and must not be treated as meta because of it.
- `wrapSystemReminder(body: string | readonly string[])` is only the text wrapper: an array is joined with `\n`, a string keeps existing formatter call sites; it produces exactly one `<system-reminder>...</system-reminder>` layer.
- Descriptor fields never appear in provider serialization.
- The descriptor does not define `projectionPolicy`, `cachePolicy`, `mergeIntoCurrentTurn`, `cacheControl` or other provider projection semantics. `MessageHistory` internal metadata (SR4) stores only `source` identity, for preventing user-text misclassification, hydrate/source restoration and the Todo cadence marker. Future merge/cache rules belong in a projector/helper based on the source catalog, not in persisted message metadata.

## Phases

### Phase SR0: Source taxonomy + wrapper helper

Establish the taxonomy and the unified wrapper, with no provider projection.

- Files: `packages/core/src/system-reminder/source.ts`, `packages/core/tests/system-reminder-source.test.ts`.
- Add `SystemReminderDeliveryChannel`, `SystemReminderLifecycle`, `SystemReminderSource`, `SystemReminderSourceDescriptor`, `getSystemReminderDescriptor(source)` (or source-specific helpers) and `wrapSystemReminder(...)` that outputs exactly one wrapper.
- Tests: channel/lifecycle/isMeta/providerVisibility/evidenceLabel of every active source; nested wrapper is rejected or normalized to a single layer; real user text starting with `<system-reminder>` is not inferred as a meta source; the descriptor has no projection/cache-control fields.

### Phase SR1: Existing reminder source inventory

Make the existing provider-visible sources explicit without breaking their text semantics.

**SR1.1 current-turn sources** (files: `runtime/methods/{hooks,memory-recall,turn-loop}.ts`, `runtime/helpers/conversation.ts`):

- Hook additional context stays provider-visible: `hook_context` / `current_turn`.
- Relevant memory stays provider-visible: `relevant_memory` / `current_turn`. Only source/tag ownership is done; whether to emit one message per memory with full text needs a separate decision.
- Plan mode reminder keeps ZCode's read-only/plan-mode semantics: `runtime_mode` / `current_turn` (content/cadence in SR9).
- Auto mode uses `runtime_mode` / `current_turn` only if ZCode has a real producer; otherwise record absent, no shell.
- The active goal/target request-time reminder was removed later; there is no `runtime_target` source. The `target_continuation` auto-continuation input stays.
- Output style reminder is inserted only when the current output style is non-default and non-empty (`output_style` / `current_turn`); default/empty inserts nothing. Its content is polished in SR9 so it does not duplicate the system prompt `output_style` section.
- Standalone / append behavior of these reminders in `messages` is unchanged.

**SR1.2 prefix/tool/history sources** (files: `context/sections/skills.ts`, `context/builder.ts`, `tool/handlers/read.ts`, `runtime/methods/{resume,target}.ts`):

- Skill listing stays `request_prefix` / `skills_listing`, not merged into current-turn; the incremental-by-new-skill attachment path is not implemented.
- Generic context meta-user system-reminder stays `request_prefix` / `context_prefix`, labeled separately from `skills_listing`.
- Read empty-file / short-read warning stays `tool_result` / `tool_result_warning`.
- Resume restored todos: `history_continuity` / `resume_todo_state`. Resume restored goal: `history_continuity` / `resume_goal_state`.
- Target continuation prompt is an independent provider-visible source using the `target_continuation` wrapper. After merge it is written into session/protocol metadata through `inputSource: "goal-continuation"` / `inputVisibility: "model-only"` and bridged at the runtime/persistence/hydrate boundary to `runtimeMessage.source: "target_continuation"`. The provider body carries no `source=` attribute.

**SR1.3 ZCode-specific existing producers** (files: `runtime/helpers/{model-anomaly,rewind}.ts`, `contracts/src/tools/target.ts`):

- Repeated tool call / tool call budget warnings: `model_anomaly`; channel follows the actual insertion path (prefer `mid_turn_event`; `current_turn` if it is next-request dynamic context).
- Conversation rewind, workspace rewind, workspace fork notice: `rewind_notice` / `history_continuity`.
- Goal completion verification reminder: `goal_completion_verification` / `tool_result`, keeping the provider-visible text. The formatter lives in the contracts/tool-result surface; failure feedback goes into the GoalUpdate tool result; the verifier auxiliary request is marked by `querySource: target_completion_verification` and does not enter `MessageHistory` runtime metadata. Unifying source/evidence metadata would need a separate tool-result metadata envelope design.

Provider bodies do not leak descriptors; tests verify source ownership through formatters/helpers or trace-side evidence.

### Phase SR2: Runtime-local date change

Add the `date_change` reminder with runtime-local semantics, without refreshing the request-level current date prefix.

- Shared local `YYYY-MM-DD` helper: `packages/contracts/src/time/local-date.ts` (exported from `contracts/src/index.ts`), also used by the context source adapter `currentDate` (`adapters/src/context/index.ts`); no UTC-only path. Test: `contracts/tests/local-date.test.ts`.
- Runtime state (`lastEmittedLocalDate` or equivalent; files `runtime/{internal,agent-runtime}.ts`, `runtime/methods/turn.ts`):
  - Fresh runtime first turn: record the local date, send no reminder.
  - Resume first turn: record the local date, send no reminder.
  - Same runtime across a local date change: send one `date_change` / `current_turn` reminder.
  - `/clear` / equivalent reset: no independent `/clear` runtime reset path exists, recorded as absent.
  - `date_change` never refreshes, rebuilds or modifies the request-level `current_date` prefix.
- Whether `date_change` merges with the human prompt into one `content[]` is not this phase's concern.

### Phase SR3: Todo / task / goal reminder semantics

Fix provider-visible text semantics and lifecycle of ZCode-supported planning-state reminders. SR3 once had a per-request todo-state baseline; the regular turn is now replaced by the SR5 `todo_reminder` cadence and `todo_state` is no longer an active source (this phase explains why).

- **Todo state (SR3.1):** Resume restored todo state stays a provider-visible system-reminder (`resume_todo_state` / `history_continuity`). The historical per-request non-empty todo-state reminder is disabled: a regular turn, whether todos are empty or not, no longer sends a per-request todo-state reminder; only SR5 cadence sends `todo_reminder`.
- **Goal / target state (SR3.2):** The active target state request-time reminder was removed (no goal-state system-reminder is appended to regular model requests). Resume restored goal state stays `resume_goal_state` / `history_continuity`. The target continuation prompt stays an independent turn/source, not folded into current-turn reminders. Tests cover goal text as untrusted/user-provided data that is never upgraded to a system instruction.
- **Task status (SR3.3):** Provider-visible task/background status notification uses `task_status` / `mid_turn_event`. The session store keeps the raw `<task-notification>`; the system-reminder outer layer is added for the current request and when session hydrate rebuilds provider history. If no producer exists, record absent.

### Phase SR4: MessageHistory semantic metadata

Provide generic runtime metadata for Todo cadence and later provider request merge; the final provider request body does not change in this phase.

Design: metadata lives in `MessageHistory` internal entries and never leaks into the provider message shape. `toModelMessages()` keeps returning provider-clean `ModelInputMessage[]`; a new runtime/internal API lets cadence, projection and cache-control finalization read metadata.

**SR4.1 envelope** (`core/src/agent/message-history.ts`, `message-history.test.ts`):

- Core-local `RuntimeMessageMetadata` / `RuntimeMessageEntry`, internal entry `{ message: ModelInputMessage; metadata?: RuntimeMessageMetadata }`.
- `RuntimeMessageMetadata` contains only `source: RuntimeMessageSource`; no `origin`, `channel`, `lifecycle`, `projectionPolicy`, `cachePolicy`, `turnId`, `messageId` or descriptor evidence fields. Channel/lifecycle/evidence are looked up from `SystemReminderSourceDescriptor`.
- `MessageHistory.addUser(...)` accepts optional metadata; clone/reset/replace never drop existing entry metadata.
- `toRuntimeEntries()` returns deep-cloned entries for Todo cadence / provider projection.
- `toModelMessages()` returns only provider-safe messages.
- `countContextPrefixMessages(...)` prefers metadata source to detect leading `context_prefix` / `skills_listing`; the legacy leading `<system-reminder>` fallback applies only when metadata is missing.
- Tests: metadata deep clone; `toModelMessages()` does not leak metadata; real user text starting with `<system-reminder>` with `real_user` metadata is not taken as prefix; the legacy fallback still works.

**SR4.2 producer annotation** (runtime methods `context, hooks, memory-recall, turn, turn-loop, resume, background-notifications, steering, rewind, rewind-message, turn-tool-warnings, compact-active, target-completion-verification`, helpers `conversation`, `media-budget`; tests `runtime-reminders`, `runtime-compact`, `media-budget`, `runtime-trace`, `runtime-tool-loop`):

- Request-prefix context messages use source-only metadata `context_prefix` or `skills_listing`.
- Config refresh reuses `buildContextHistoryEntries(...)` to rebuild context prefix metadata and keeps conversation metadata through `toRuntimeEntries()`, so refresh does not fall back to `<system-reminder>` text detection.
- Real user prompts use `source: "real_user"`; this turn's `turnId/messageId` is not written to runtime metadata.
- Hook additional context, relevant memory, date_change, runtime mode, output_style each use their own source-only metadata; resume todo/goal use `resume_todo_state` / `resume_goal_state`.
- Background task notification uses `task_status` in provider-visible history; the session store stays raw `<task-notification>` and the provider history adds the `task_status` wrapper.
- Synthetic user notice persistence keeps the old `metadata.source` for UI/compat queries and writes only `{ source }` under `metadata.runtimeMessage`; a missing valid `runtimeMessage` gets default source-only metadata; request-time overlay / request prefix is not persisted.
- Only metadata is annotated: no content merge, no reorder. For regular turn, compact and goal completion verification, the latest-user cache-control is finalized from source-aware entries; media-budget's provider-clean fallback prefers the latest real user cache-control identity, not `<system-reminder>` text.
- Tests: metadata exists in `toRuntimeEntries()` but not in `ModelRequest` / adapter request / `toModelMessages()`.

**SR4.3 hydration** (`core/src/agent/session-history-hydrator.ts`, tests `session-history-hydrator`, `session-history-rewind`):

- For `TextPart.synthetic === true`, derive runtime metadata, preferring `metadata.runtimeMessage.source` and ignoring any old persisted `origin/channel/projection/cache/turnId/messageId/evidence` fields.
- Without `metadata.runtimeMessage`, fall back to the old `metadata.source`: `background_task` -> `task_status`; `subagent` -> `queued_system_notification`; `rewind` / `fork` -> `rewind_notice`; unknown synthetic -> `legacy_synthetic`.
- Non-synthetic user text starting with `<system-reminder>` keeps real user metadata or no metadata; it is never inferred as meta.
- After hydration the provider-visible body keeps source semantics: metadata never enters provider JSON; raw persisted background task text still gets the `task_status` wrapper in provider history; the `todo_reminder` marker stays wrapped provider-visible text and keeps taking part in cadence.

### Phase SR5: Todo reminder cadence

Replace the SR3 per-request non-empty `todo_state` reminder with cadence: send a TodoWrite reminder only when TodoWrite is available and unused/unreminded for a long time, identifying the last reminder marker by MessageHistory metadata.

**SR5.1 source and helpers** (`system-reminder/source.ts`, `runtime/helpers/conversation.ts`, tests `system-reminder-source`, `runtime-reminders`):

- `todo_reminder` descriptor: `channel: "current_turn"`, `lifecycle: "per_current_turn"`, `isMeta: true`, `providerVisibility: "provider_visible"`.
- `TODO_REMINDER_CONFIG`: `TURNS_SINCE_WRITE = 10`, `TURNS_BETWEEN_REMINDERS = 10`.
- `getTodoReminderTurnCounts(entries)` scans `RuntimeMessageEntry[]` backwards and counts assistant turns since the latest TodoWrite assistant tool call and since the latest `source === "todo_reminder"`. No special skip for thinking/reasoning-only messages (counted as assistant turns when they are provider-visible assistant messages).
- `buildTodoReminder(todos)` text semantics: TodoWrite has not been used for a long time; consider using/cleaning the todo list; use only if relevant; do not mention the reminder to the user; attach the existing todo list when todos are non-empty.
- Tests: counting with no TodoWrite, latest TodoWrite, latest todo_reminder, both thresholds met/not met.

**SR5.2 cadence injection** (`runtime/helpers/conversation.ts`, `runtime/methods/{turn-loop,index}.ts`, `runtime/internal-methods.ts`, tests `runtime-tool-loop`, `runtime-trace`):

- The SR3 per-request non-empty todo-state append path in `buildRuntimeRequestEntries(...)` is removed/disabled.
- Before regular turn request assembly, `maybeInjectTodoReminder(...)` (or equivalent) runs and continues only if the currently exposed tools include `TodoWrite`. ZCode has no brief / direct-to-user message tool, so the extension gate exists but skips nothing.
- When `turnsSinceLastTodoWrite >= 10` and `turnsSinceLastReminder >= 10`, a wrapped `todo_reminder` with source-only metadata `source: "todo_reminder"` is added to `messageHistory`, standalone (no provider projection yet).
- With a sessionStore, synthetic notice persistence records the wrapped provider-visible text plus `metadata.source = "todo_reminder"` / `metadata.runtimeMessage.source = "todo_reminder"`, so hydrate restores the marker and resume does not repeat the reminder.
- The provider request no longer carries the SR3 authoritative todo-state reminder; `todo_reminder` text appears only when cadence is due.
- Tests: not inserted before 10 assistant turns; inserted at 10; not repeated within 10 turns after insertion; counter resets after TodoWrite; not inserted when TodoWrite is not exposed; with empty todos a reminder is still allowed without a todo list; with non-empty todos the list is attached.

**SR5.3 resume/hydrate continuity** (`session-history-hydrator.ts`, tests `session-history-hydrator`, `runtime-trace`):

- Hydrated `todo_reminder` synthetic parts restore the MessageHistory marker so `getTodoReminderTurnCounts(...)` recognizes it; hydrated assistant TodoWrite tool calls remain cadence reset markers.
- After resume, no repeat if fewer than 10 assistant turns passed since the last todo_reminder; a new `todo_reminder` is allowed when both the last TodoWrite and last todo_reminder meet the thresholds.
- The provider request body does not leak MessageHistory metadata.

### Phase SR6: Attachment-origin reminder content

Inventory and complete ZCode-supported attachment-origin system-reminder text without changing attachment order / bubble-up. Files: `system-reminder/prompt-attachment.ts`, `runtime/helpers/conversation.ts`, `agent/session-history-hydrator.ts`, tests `runtime-persistence`, `session-history-hydrator`.

- Supported provider-visible prompt attachment types: `file` text preview / local text file, `image` image block, `url` resource surface, read-failure/too-large placeholders. `TurnAttachment` does not support directory attachments.
- Treatment: text/file uses the ZCode generic `prompt_attachment` reminder; image keeps its provider block; URL is `resource_link` before the adapter and a `[Resource: ...]` text placeholder in the final OpenAI-compatible body; a placeholder gets a reminder only when its mime is text.
- UI-only / control-only / telemetry-only attachments produce no provider reminder. MCP resources stay P-15 postponed.
- For text/file attachments that lack explanatory context in the provider body, add the `prompt_attachment` source-owned system-reminder text; live turn and session hydrate restore the same semantics.
- Non-text blocks (image, resource_link, file data block, etc.) stay unchanged and are not swallowed by the wrapper.
- The active slice does not assert attachment blocks before the human prompt; only reminder text and non-text block fidelity.
- The synthetic Read tool call/result shape is not implemented here (landed in SR12).

### Phase SR7: Mid-turn system events

Separate system-origin notifications from human queued input so real user input is never misjudged as a meta reminder. Files: `runtime/methods/steering.ts`; tests `runtime-tool-loop`, `session-history-hydrator`, `system-reminder-source`.

- Queued human input stays `real_user`, even if its text starts with `<system-reminder>`; a focused runtime test covers a steered input with a literal tag still getting cache-control as the latest real user.
- System-origin queued notification uses `queued_system_notification` / `mid_turn_event`. The current producer is the subagent notification; runtime metadata/persistence/hydrate source is covered, and the provider-visible wrapper/content gap was closed by SR11.
- Diagnostics, if provider-visible, would use `diagnostics` / `mid_turn_event`; only internal diagnostics/logging exists in context/skill/plugin/model runner, so recorded as absent.
- Background task status is already `task_status` / `mid_turn_event` (SR3/SR4).
- Producers that do not exist are recorded absent, no shell reminders.

### Phase SR8: Evidence + docs

Prove source/content with prompt-trajectory and focused tests.

- Trajectory testcase `testcases/system-reminder-sources` (`prompt.txt`, `expect.json`) covers the provider-visible badcase of a real user prompt starting with `<system-reminder>`. Runner boundary: `run:testcases` only produces a single-turn `submitPrompt` from `prompt.txt`; `expect.json` is a manual inspection contract and does no multi-turn automatic assertion.
- Focused Vitest covers at least one current-turn, one prefix, one tool-result and one history-continuity source; `date_change` multi-turn; output style (non-default/non-empty emits `output_style`, default/empty does not); Todo reminder cadence (below threshold absent, at threshold `todo_reminder`, no per-request authoritative todo-state reminder).
- Derived provider request bodies are exported to `out/system-reminder-sources/` (final output only); assertions that provider body contains/excludes the reminder text and does not contain descriptor/provenance/evidence metadata.
- Only source/content is marked complete; content merge / bubble-up are not.
- If repo-wide `pnpm typecheck` / `pnpm lint` fails for unrelated existing reasons, record the failing files and run focused package checks.

### Phase SR9: Current-turn reminder content polish

Complete the semantics and cadence of `runtime_mode`, `output_style`, `date_change`, `todo_reminder`; no content merge / provider projection. Helper: `runtime/helpers/runtime-reminders.ts`; E2E `testcases/system-reminder-sr9-runtime/fixture.json`.

- **`runtime_mode` / plan mode:** the first plan turn sends the full reminder; after a plan reminder exists, nothing is repeated within 5 human turns; the 1st, 6th, 11th... attachment uses the full reminder, the rest use a sparse reminder. The full reminder keeps ZCode's own tool names and mode semantics: plan mode active, no non-read-only modification / non-read-only tools, wait for user switch/confirmation before implementing; no plan-file/edit-boundary tool names ZCode lacks. The sparse reminder says plan mode is still active, the read-only restriction still applies, and plan approval is not an ordinary text question (no exact wording required). Tool names ZCode did not have at the time (such as `ExitPlanModeV2`, `AskUserQuestion`) are not hard-coded; ZCode's current mode-switch / clarification semantics are used. Tests: first plan request has the full reminder; consecutive follow-ups within 5 human turns do not repeat; after the cadence a sparse/full reminder appears; normal mode has no `runtime_mode`.
- **`output_style` tail reminder:** active condition unchanged (`outputStyle` non-empty and prompt non-empty). Content only says the `<style name> output style is active` and that its guidelines must be followed; the full `outputStyle.prompt` is not repeated (the system prompt dynamic `output_style` section carries it). It is injected as an in-memory runtime history marker per user turn, not a persistent synthetic notice; later model requests of the same turn's tool loop do not append it again. Tests: active style yields only style name / active hint; default/empty has no reminder; the second round's request sees the previous round's runtime-history reminder; the session store does not persist it.
- **`date_change` wording:** keeps the SR2 lifecycle; content says the date has changed, today's date is now the new date, and tells the model not to mention the reminder to the user; uses the same local `YYYY-MM-DD` helper. Tests: cross-day reminder contains the new date and the not-mention semantics.
- **`todo_reminder` wording:** SR5 cadence unchanged (TodoWrite exposed; latest TodoWrite and latest reminder both reach 10 assistant turns); no per-request todo-state baseline. Content: TodoWrite unused for a long time; consider it if progress tracking fits the task; clean up a stale list; use only if relevant; ignore if not applicable; never mention the reminder. Non-empty todos attach the list; empty todos still allow a gentle reminder without an empty list. Tests cover "ignore if not applicable" / "only if relevant" / "never mention" semantics and the attached list.

```bash
pnpm --filter @zcode/core exec vitest tests/runtime-reminders.test.ts tests/runtime-trace.test.ts tests/runtime-persistence.test.ts tests/runtime-tool-loop.test.ts --run
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/core build
pnpm --filter @zcode/prompt-trajectory exec node --import tsx --test tests/*.test.ts
pnpm --filter @zcode/prompt-trajectory typecheck
pnpm --filter @zcode/prompt-trajectory lint
pnpm --filter @zcode/prompt-trajectory run:testcases -- --cases testcases --out-root out/system-reminder-sr9
```

After the run, inspect the latest `apps/zcode-cli/tools/prompt-trajectory/out/system-reminder-sr9/test*/**/trajectory.jsonl` and `.../trajectories/*.openai_request_body.json`; every provider-visible message must match SR9 before asking for confirmation.

SR9 prompt-trajectory coverage boundary:

- Covered by `system-reminder-sr9-runtime`: first-turn full `runtime_mode`, no repeat before 5 human turns, `output_style` tail reminder without the full style prompt, and output_style in-memory history tracking. Latest validated output: `apps/zcode-cli/tools/prompt-trajectory/out/system-reminder-output-style-memory/test20260604-161114` (a single incremental-derived `0001.openai_request_body.json` for the two-turn run, two output_style reminders, no `0002-non-incremental-change` file).
- Covered by focused Vitest only: `date_change` and `todo_reminder`, because the prompt-trajectory fixture runner has no deterministic local date injection or seeded TodoWrite/tool-call history.

### Phase SR10: System-reminder tag wrap audit

Inventory all final provider-visible `<system-reminder>` attachment/tool-result/userContext sources and confirm every ZCode active source is tag-wrapped; judged by final content only, not by implementation path.

- Candidates audited: plan_mode, output_style, date_change, todo_reminder, task_reminder, diagnostics, queued_command, task_status, hook family, relevant_memories, skill_listing, file/directory attachment, deferred_tools_delta, agent_listing_delta, mcp_instructions_delta, compaction/context-efficiency, verify_plan_reminder, etc. Each is marked `active wrapped`, `active unwrapped`, `active different structure`, `ZCode-specific`, `postponed` or `absent by decision`.
- Active sources have focused tests asserting exactly one `<system-reminder>` wrapper and no source/descriptor leak.
- `tool_result_warning` keeps the tool-result inline wrapper and need not become a synthetic user notice.
- ZCode-specific sources (`model_anomaly`, `rewind_notice`, `resume_goal_state`, `goal_completion_verification`) are accepted only on their own wrapper, by their own semantics; `runtime_target` was removed and is no longer an active source.

Evidence: `system-reminder-source.test.ts` covers exactly-one wrapper for every registered provider-visible source, nested tag escaping and no descriptor metadata leak; `runtime-reminders.test.ts` covers the `rewind_notice` conversation fork producer using the unified wrapper and escaping nested tag-like text; `target-tool.test.ts` covers the `goal_completion_verification` tool-result content having exactly one wrapper (the function lives in the contracts layer and keeps a hand-written tag so contracts does not depend on a core helper). Prompt-trajectory output: `apps/zcode-cli/tools/prompt-trajectory/out/system-reminder-sr10-tag-wrap/test20260604-163037`; the `system-reminder-sources` and `system-reminder-sr9-runtime` request bodies have no `source=` / `runtimeMessage` / descriptor leak and no `*-non-incremental-change.openai_request_body.json`.

### Phase SR11: Queued system notification / subagent notification wrapper

Unify the provider-visible content of subagent notifications under `queued_system_notification` with the `<system-reminder>` wrapper, while the session store / UI transcript keeps the raw `<subagent-notification>`.

Rules:

- Human queued input stays user-authored; system-origin / task-notification origin uses the `<system-reminder>` wrapper; for array content only text blocks are wrapped and image blocks are kept.
- Background Bash `<task-notification>` already follows this rule: live provider history wraps it as `task_status`, the session store stays raw, hydrate re-adds the wrapper.
- Before SR11, the subagent background notification wrote a raw `<subagent-notification>` to provider history although its metadata source was `queued_system_notification`; this was the only active wrapper/content gap.
- Implementation: `formatBackgroundCompletionNotification(...)` / `formatBackgroundFailureNotification(...)` and the persisted session part stay raw. Only the live drain and the hydrate provider projection boundary wrap with `wrapSystemReminderForSource("queued_system_notification", rawText)`, so the UI transcript and persisted raw text are unchanged and existing source metadata prevents misclassification.
- Session hydrate adds the same provider-visible wrapper for `runtimeMessage.source === "queued_system_notification"` and legacy `metadata.source === "subagent"` (no double wrap after hydrate).
- Tests (`subagent-explore`, `session-history-hydrator`, `runtime-tool-loop`, `system-reminder-source`): a subagent completion notification has exactly one `<system-reminder>` wrapper in the provider body (live and hydrate); persisted raw text stays compatible with old sessions; human queued input is not wrapped.
- Prompt-trajectory gained request-matched mock responses and an event-wait step (files `tools/prompt-trajectory/src/{fixture,record,openai-provider-proxy}.ts`, testcase `system-reminder-sr11-subagent-notification/`): a deterministic mocked subagent fixture waits for `subagent_stopped` and then submits a follow-up.
- Evidence: `tools/prompt-trajectory/out/system-reminder-sr11-subagent-notification/test20260604-sr11`. The final parent follow-up request is `trajectories/0004-non-incremental-change.openai_request_body.json` (`non-incremental` comes from interleaved parent tool-loop, child subagent and parent follow-up requests, not a content mismatch); it has exactly one open/close of `<system-reminder>` and `<subagent-notification>` and no `runtimeMessage` / `providerVisibility` / `evidenceLabel` / `source=` leak.

```bash
pnpm --filter @zcode/core exec vitest tests/subagent-explore.test.ts tests/session-history-hydrator.test.ts tests/runtime-tool-loop.test.ts tests/system-reminder-source.test.ts --run
pnpm --filter @zcode/prompt-trajectory record -- --fixture testcases/system-reminder-sr11-subagent-notification/fixture.json --out out/system-reminder-sr11-subagent-notification/test20260604-sr11
pnpm --filter @zcode/core typecheck
```

### Phase SR12: Synthetic attachment meta text shape

Beyond the SR6 generic `prompt_attachment` reminder, decide the meta-user text shape of attachment-origin synthetic Read / Bash tool call/result. It comes last because it changes how text/file attachments are expressed to the provider rather than adding reminder wording; synthetic tool call/result is meta-user text ("Called the ... tool..." / "Result of calling ..."), not a real provider tool_use/tool_result boundary, and needs separate live/hydrate, summary/compact, prompt-trajectory and later provider projection handling.

Decision: `text-simulated`. The `prompt_attachment` `<system-reminder>` text simulates a ZCode `Read` call/result and creates no real provider tool-result boundary. Scope is limited to ZCode-supported file-source text attachments; source-less inline text keeps the neutral wrapper; directory/Bash, bubble-up and content merge stay out of scope.

Implementation (files `system-reminder/prompt-attachment.ts`, `runtime/helpers/conversation.ts`, `agent/session-history-hydrator.ts`, tests `runtime-persistence`, `session-history-hydrator`):

- Live turn and hydrate prefer the user-submitted attachment reference as `file_path`, so nested paths are not truncated to a basename; both generate the same provider-visible shape.
- Image/file data blocks stay intact; URL/resource surface stays ZCode-specific content outside the wrapper and is not swallowed by the synthetic Read wrapper.
- Session store / UI transcript structure is unchanged; any extra metadata lives only at the runtime/provider projection boundary, not in the UI-facing message body.
- The synthetic attachment shape is not counted in the real tool execution ledger, Todo/tool cadence or permission flow.
- Tests: live nested path, hydrate nested path, source-less inline text neutral wrapper, truncated text file, read-failure placeholder, image/resource surface unchanged.
- Prompt-trajectory evidence: at least one nested file-source text attachment testcase and one URL/resource attachment testcase under `testcases/system-reminder-sources/...`. SR6 generic reminder and SR12 synthetic Read shape are tracked separately.

```bash
pnpm --filter @zcode/core exec vitest tests/runtime-persistence.test.ts tests/session-history-hydrator.test.ts tests/runtime-trace.test.ts --run
pnpm --filter @zcode/prompt-trajectory run:testcases -- --cases testcases --out-root out
pnpm --filter @zcode/core typecheck
pnpm typecheck
pnpm lint
```

## Final acceptance

- Every active source has a clear owner, channel, lifecycle, isMeta, providerVisibility and evidenceLabel.
- Existing hook / memory / plan / skill listing / tool-result / resume reminders stay provider-visible with clear ownership.
- `runtime_mode` / plan mode follows the content/cadence rules: full first turn, human-turn cadence, full/sparse cycle, no tool names ZCode lacks.
- `date_change` is runtime-local: fresh/resume first turn only records the date, a same-runtime day change sends once, the request-level prefix is not refreshed, and the model is told not to mention it.
- `output_style` is sent only for non-default/non-empty styles; the tail reminder only signals the active style.
- The goal/target request-time reminder is removed; `target_continuation` model-only continuation stays. Regular turns use SR5 `todo_reminder` cadence with SR9 wording (only-if-relevant / ignore-if-not-applicable / never-mention); no per-request todo-state baseline.
- Skill listing stays a request-prefix source (incremental attachment listing not implemented; skill discovery postponed). Tool-result warnings stay tool-result sources.
- ZCode-specific producers (context prefix, model anomaly, rewind/fork notice, goal completion verification) all have source taxonomy.
- Human queued input stays a real user source and is never misjudged by `<system-reminder>` text.
- Attachment-origin system-reminder covers only ZCode-supported provider-visible types; no order / bubble-up. File-source text attachments use the synthetic `Read` meta-user text shape; source-less inline text invents no tool name; directory/Bash has no active producer.
- The tag-wrap audit is complete; active sources have focused tests proving exactly one wrapper.
- `queued_system_notification` / subagent notification has live/hydrate wrapper implementation, focused tests and prompt-trajectory e2e; session/UI raw notification is unchanged.
- ToolSearch/deferred tools, MCP instructions/resources, skill discovery, bubble-up, content merge and cache-control finalization are not implemented here.
- Provider JSON does not leak descriptor/provenance/evidence metadata. Prompt-trajectory evidence covers only system-reminder source/content/channel, not `content[]` merge shape.
