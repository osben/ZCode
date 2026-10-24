# Mid-conversation System Projection Implementation Plan

> Phase by phase. Do not move to the next phase without user confirmation after tests, code review and prompt-trajectory evidence. Do not commit unless the user explicitly asks after review.

**Status:** Implemented (MCS0-MCS4 and MCS-FU1/FU2 complete; MCS1.8 source expansion landed). The capability gate that this plan originally excluded is added by [MCS dynamic capability projection plan](./mcs-dynamic-capability-projection-plan.md).

**Goal:** Without changing the Anthropic beta/header and without a provider capability gate, adopt the Anthropic Messages API `mid-conversation-system-2026-04-07` capability for ZCode's provider-visible message shape: apart from the request-level userContext / real-user / tool-result boundaries, source-owned internal meta reminders are projected from user `<system-reminder>` to a mid-history `role: "system"` message.

**Architecture:** meta attachment -> request normalize -> system render. ZCode has a structured runtime attachment entry internally. Producers express semantics and a raw body; provider request finalization decides whether the final output is `role: "system"` or the user `<system-reminder>` fallback; `RuntimeMessageMetadata` stays source-only. `ContextBuilder` no longer produces wrapped meta-user messages: it produces `systemMessages` and raw `metaUserAttachments`, which the runtime layer converts to source-aware attachment entries. Synthetic user system-reminder text already persisted in historical sessions (hydrate/replay) is not upgraded to an attachment entry and not projected to mid-conversation system; it keeps the old role:user provider-visible shape. `prompt_attachment` used to be embedded in the real user `content[]` block and needed a block-level split so real user text is never mistaken for a meta reminder.

## Scope

In scope: project these existing ZCode provider-visible reminders to `role: "system"` in the final provider request:

`skills_listing`, `todo_reminder`, `runtime_mode`, `hook_context`, `relevant_memory`, `referenced_session_context`, `task_status`, `queued_system_notification`, `resume_todo_state`, `resume_goal_state`, `rewind_notice`, `model_anomaly`, `output_style`, `date_change`, `plan_mode_exit`, `diagnostics`, and `prompt_attachment` (as an independent runtime attachment entry).

Also in scope:

- Request-level userContext / currentDate / user instructions / project context keeps the user `<system-reminder>` shape; it is not migrated to `role: "system"`.
- `target_continuation` keeps model-only user input semantics; `tool_result_warning` / `goal_completion_verification` keep their tool-result / auxiliary-result boundary; none is an ordinary MCS meta reminder.
- Final provider projection merges adjacent user messages unconditionally (not only in the MCS fallback), to avoid consecutive-user shape drift.
- Runtime metadata does not leak into the provider body; the cache-control anchor stays on the last non-system message after final projection.

Out of scope:

- Adding, changing or auto-injecting `anthropic-beta` / provider headers.
- A provider/model capability gate (this plan assumes first-party + Opus 4.8 with mid-conversation system enabled; the gate lives in the dynamic capability plan).
- Reminder wording: ZCode keeps its own tool and product names; this plan changes only channel and shape.
- ToolSearch/deferred tools, MCP instructions, full skills/compact reinjection.
- Session persistence schema refactors; migrating or rewriting persisted synthetic user system-reminder messages (hydrate/replay keep the old role:user shape).

## Follow-ups (feature-complete)

| ID | Type | Record | State |
| --- | --- | --- | --- |
| MCS-FU1 | legacy bugfix | Fixed: when a text/file attachment fails to read, the text placeholder with `metadata.errorCode === "attachment_read_failed"` no longer enters provider-visible user content. The filter covers only failed text stubs; intentional `local_ref` binary/large-file handles, URL/resource links, pasted image placeholders and source-less inline text attachment reminders are unaffected. | Done, focused regression covers it. |
| MCS-FU2 | provider wire shape | A mid-conversation system message in the final `messages[]` must stay `{ role: "system", content: string }`. ZCode Core emits a string but the AI SDK Anthropic serializer turns it into a one-element text-block array. The fix is only at the Anthropic final fetch boundary: restore a single pure text block of `messages[].role === "system"` to a string. Prompt-trajectory export keeps the recorded MCS content as is; top-level `system[]`, other roles, cache-control and other providers are untouched. The formal regression uses a deterministic Anthropic / Opus 4.8 SR12 fixture asserting the final provider request MCS `content` is a string; the SR11 fixture is aligned with the current Agent background-launch wording, `<task-notification>` and the automatic parent continuation order. | Done, formal trajectory fixture passes. |

## Code facts

- `RuntimeMessageMetadata` is `{ source }` only (`packages/core/src/agent/message-history.ts`).
- `RuntimeMessageEntry` supports `kind: "message"` and `kind: "attachment"`; an attachment entry stores a raw body; a legacy message entry does not take part in mid-conversation system projection.
- `SystemReminderSource` is split into prefix / persisted / per-request (`packages/core/src/system-reminder/source.ts`).
- `ContextBuildResult` exposes only `systemMessages` and raw `metaUserAttachments`.
- The provider-visible request finalization entry is `buildProviderRequestMessages(...)` in `packages/core/src/runtime/helpers/provider-request-messages.ts`. It projects the raw bodies of attachment entries (every source except `context_prefix`, `target_continuation`, `tool_result_warning`, `goal_completion_verification`) to `role: "system"`; a legacy wrapped message keeps its role:user shape even with source metadata.
- `skills_listing` / `context_prefix` come from `ContextBuilder.metaUserAttachments` through `buildContextHistoryEntries(...)`; `skills_listing` projects to `role: "system"`, `context_prefix` falls back to user `<system-reminder>`.
- `todo_reminder` / `output_style` / `plan_mode_exit` are added as attachment entries in `runRegularTurnLoop(...)` (`todo_reminder` still persists a wrapped synthetic notice as the resume/cadence marker); `date_change` is added in `executeTurn(...)`.
- `prompt_attachment` is split by `buildRuntimeUserEntriesFromTurn(...)` at the live turn / hydrate attachment source boundary into an independent raw attachment entry; the real user entry keeps only the prompt, URL/resource and image context.
- The AI SDK adapter already allows system roles inside `messages[]`; the Anthropic final fetch boundary restores pure-text `content` to a string; no adapter header change.

## Product decisions

| ID | Decision | Effect |
| --- | --- | --- |
| MCS-D1 | Treat `mid-conversation-system-2026-04-07` as enabled; no header/capability gate. | Implementation concerns only the provider-visible shape. |
| MCS-D2 | Only source-owned runtime attachment entries migrate; the MCS source set is an exclusion table, not a global migration of the `<system-reminder>` literal tag. | Real user text and request-level userContext are not hit. |
| MCS-D3 | `context_prefix` stays user `<system-reminder>`. | Request-level userContext keeps its user context form. |
| MCS-D4 | `skills_listing` moves after the first real user prompt in the provider body and becomes `role: "system"`. | Skills listing is meta context right after the first real user prompt. |
| MCS-D5 | Provider-visible meta sources other than `context_prefix`, `target_continuation`, `tool_result_warning`, `goal_completion_verification` keep their cadence/content; only channel/wrapper/position migrate. | Lower behavior risk. |
| MCS-D6 | `prompt_attachment` is split through the source/runtime entry; only if hydrate/replay has only the old content block, fall back for strictly ZCode-generated shapes. | No generic tag heuristic. |
| MCS-D7 | Cache-control is finalized after mid-system projection, skipping all `role: "system"` messages. | The cache anchor is always the last non-system message. |
| MCS-D8 | Every phase ends with focused unit tests + prompt-trajectory e2e, output under `apps/zcode-cli/out/`. | Acceptance is the final provider request body. |
| MCS-D9 | Hydrate/replay does not bridge historical synthetic user system-reminder into attachment entries nor exact-unwrap it into mid-conversation system. | Old sessions keep role:user; only new runtime attachment entries take part in mid-system projection. |
| MCS-D10 | Projection finally merges adjacent user messages unconditionally. | Main path and fallback end the same way. |

## File map

| File | Responsibility |
| --- | --- |
| `packages/core/src/agent/message-history.ts` | Runtime attachment entry type, clone/render helpers; metadata stays source-only. |
| `packages/core/src/context/builder.ts`, `context/types.ts` | Assemble stable/dynamic `systemMessages` and raw `metaUserAttachments` without wrapping system-reminder; define the `ContextBuildResult` boundary. |
| `packages/core/src/runtime/helpers/provider-request-messages.ts` | Provider request projection entry; mid-conversation system projection from attachment entries. |
| `packages/core/src/system-reminder/source.ts` | Mid-conversation source helper, body sanitizer, fallback wrapper; no unwrap helper. |
| `packages/core/src/runtime/helpers/conversation.ts`, `runtime/methods/turn.ts` | `prompt_attachment` split out of real user content; regular turn writes real user + prompt attachment runtime entries. |
| `packages/core/src/runtime/methods/turn-loop.ts` | Confirms todo/output/plan-exit shape after projection (call parameters/comments only). |
| `packages/core/tests/{provider-request-messages,prompt-attachments,runtime-reminders,runtime-trace}.test.ts` | Projection, attachment split, reminder wording/cadence, provider request event / metadata stripping. |
| `apps/zcode-cli/worklogs/trajectory-align-log.md` | Per-day brief. |

## Phases

### Phase MCS0: Baseline lock

Lock the current provider-visible differences and test entry points. Confirm the workspace has no unrelated uncommitted changes; run the provider projection tests (`pnpm --filter @zcode/core exec vitest run tests/provider-request-messages.test.ts tests/prompt-attachments.test.ts tests/runtime-reminders.test.ts`, must pass); run prompt-trajectory for a first-turn skills-listing case, a `todo_reminder` case (use a focused unit test if the runner cannot trigger it) and a text-file attachment case.

Baseline provider-visible shape: `[user "<system-reminder>...skills...</system-reminder>", user "<system-reminder>...# currentDate...</system-reminder>", user real prompt or content[]]`; a text file attachment is a user text block `<system-reminder>\nCalled the Read tool with the following input: ...\n</system-reminder>`.

### Phase MCS1: Entry-level mid-conversation system projection

Project meta reminders that already exist as independent `RuntimeMessageEntry` items, source-aware; prompt attachments embedded in real user `content[]` are MCS2.

- Source helper `isMidConversationSystemSource(source)` uses an exclusion table: false for `context_prefix`, `target_continuation`, `tool_result_warning`, `goal_completion_verification`, true otherwise (the original MCS1 whitelist was `skills_listing`, `todo_reminder`, `output_style`, `date_change`, `plan_mode_exit`; `prompt_attachment` was added in MCS2 and the rest in MCS1.8). No unwrap helper.
- `skills_listing` moves from the prefix user message to just after the first real user prompt, wrapper removed. Other candidates become `role: "system"`.
- Projection pass (`projectMidConversationSystemEntries`): a candidate (attachment entry of a candidate source) becomes system text when a real user anchor exists; a candidate whose anchor is not yet emitted (e.g. `skills_listing` before the first real user) is delayed until the next real-user anchor is emitted; candidates right after the current user stay trailing and become one `role: "system"` joined by `\n\n` only when the next entry is assistant / system / tool / tool-result user / end (`canKeepMidConversationSystemBefore`); unsupported, invalid-shape or invalid-position candidates stay original user reminders. Never fake metadata and never rely on the literal tag alone.
- Real-user anchor: a non-tool-result user entry whose source is `real_user` or whose metadata is absent.
- `isAttachmentLikeUserEntry(...)` returns false for candidate sources so they are not bubbled before the prompt by the old reorder.
- Order inside `buildProviderRequestMessages(...)`: clone entries -> `reorderAttachmentLikeEntries` -> `projectMidConversationSystemEntries` -> find latest real user -> finalize cache-control on the last non-system message -> clone messages.
- Example: entries `[system "prefix", skills_listing, context_prefix(currentDate), real prompt]` project to `[system "prefix" (cache), user currentDate, user "real prompt" (cache), system "skills"]`; `[real_user "follow up", todo_reminder, output_style, runtime_mode]` project to `[user mode reminder (not migrated at that time), user "follow up", system "todo\n\nstyle"]`.
- Producer builders still return wrapped text internally; the projection, not producer text, owns the channel migration. Runtime trace asserts the final `ModelRequest.payload.messages` contains a system message with `TodoWrite` text and no `runtimeMessage`.
- Prompt-trajectory (first-turn with skills, due todo reminder) expects `[user currentDate, user real prompt, system skills listing]` and `{ "role": "system" }` for todo/output/date/plan-exit, with no migrated message containing `<system-reminder>`.

### Phase MCS1.5: Structured runtime attachment entry

Keep MCS1's provider-visible behavior but make the internal main path a structured attachment entry instead of a wrapped user message.

- `RuntimeMessageEntry = { kind: "message"; message; metadata? } | { kind: "attachment"; content: string; metadata: RuntimeMessageMetadata }`. `metadata.source` is the only metadata field; attachment `content` is a raw body, never wrapped; `cloneRuntimeMessageEntry(...)` preserves `kind`.
- `MessageHistory.addAttachment(...)` and `systemReminderAttachmentEntry(...)` add source-aware attachment entries.
- `countContextPrefixMessages(...)` treats prefix attachments with `source === "skills_listing"` like the old prefix user message.
- `buildProviderRequestMessages(...)` projects attachment entries from their raw body (no request-time unwrap on the main path); an unprojected attachment falls back to user `<system-reminder>`. A legacy message entry with `source: "output_style"` / `"todo_reminder"` (wrapped or not) stays role:user, proving projection accepts only structured attachment entries. Role/anchor/tool-result/cache-control/diagnostics helpers branch on `kind`.
- The MCS1 producers (`skills_listing`, `todo_reminder`, `output_style`, `date_change`, `plan_mode_exit`) migrate to attachment entries (files `runtime/methods/{context,turn,turn-loop}.ts`); wrapper builders remain for fallback and legacy paths. Provider body unchanged from MCS1 and does not leak `kind`, `metadata.source` or attachment internals.

### Phase MCS1.6: Centralize standalone system-reminder wrapping

Migrate the remaining standalone synthetic/runtime user message sources to raw attachment entries; producers emit only a raw body, and final projection / legacy fallback decides whether to wrap as user `<system-reminder>` or project to `role: "system"`.

- Migrated: `context_prefix`, `runtime_mode`, `hook_context`, `relevant_memory`, `referenced_session_context`, `model_anomaly`, `resume_todo_state`, `resume_goal_state`, `rewind_notice`, `task_status`, `queued_system_notification` (injection points in `runtime/methods/{context,turn-loop,turn,hooks,background-notifications,steering,memory-recall,resume,turn-tool-warnings}.ts`). `prompt_attachment` stays for MCS2.
- Each wrapped formatter gains a `*Body(...)` raw builder; the old wrapped function delegates to `wrapSystemReminderForSource(source, body)`, kept for legacy/test/session fallback (builders in `runtime/helpers/runtime-reminders.ts`, `runtime/methods/hooks.ts`, `memory/recall.ts`, `session-context/references.ts`, `runtime/helpers/{model-anomaly,rewind}.ts`, `runtime/methods/resume.ts`).
- Session persistence / UI transcript keep raw notification payload for `task_status` and `queued_system_notification` (display text unchanged).
- `wrapSystemReminderForSource` remains only in the final fallback render, legacy wrapped formatters and tool-result/real-content-block special cases. `ContextBuilder` no longer generates wrapped meta-user messages. The raw rewind body is sanitized so literal system-reminder tags cannot appear.

### Phase MCS1.7: Single canonical provider-visible assembly boundary

All messages sent to the provider, recorded as provider request body, or used for provider-visible token estimates must come from `buildProviderRequestMessages(...)`; logic that writes back to `MessageHistory` stays `RuntimeMessageEntry[]` and never writes projected model messages back.

- Removed public `entryToModelInputMessage`, `historyEntriesToModelMessages`, and `MessageHistory.toModelMessages()` / `getCacheableMessages()` / `getIncrementalMessages()`. `MessageHistory` keeps `init`, `addUser`, `addAttachment`, `addAssistant`, `addToolResult`, `toRuntimeEntries`, `replaceMessages`, cache stats/reset. The fallback user `<system-reminder>` render is private to `provider-request-messages.ts`.
- Microcompact (`runtime/methods/microcompact.ts`) is runtime-entry aware: input and output are `RuntimeMessageEntry[]`, clearing old tool result content while preserving attachment source metadata. Compact read-only message needs (`runtime/methods/compact.ts`, `runtime/helpers/compact.ts`) use `buildProviderRequestMessages({ entries: this.messageHistory.toRuntimeEntries(), applyCacheControl: false }).messages`; role checks use runtime-entry role helpers.
- Tests assert provider-visible behavior through `toRuntimeEntries()` or `buildProviderRequestMessages(...)`, not `toModelMessages()`.
- Follow-up decision (MCS-D9): persisted `task_status` / `queued_system_notification` synthetic text is not hydrated into attachment entries; provider projection does not exact-unwrap legacy message entries.
- Context-builder cleanup: `ContextBuilder` returns `systemMessages` plus raw `metaUserAttachments`; the runtime converts them with `systemReminderAttachmentEntry(...)`, removing the old context-prefix metadata shift and any parallel builder-level wrapped producer path.

### Phase MCS1.8: Source expansion + generic adjacent user merge

The MCS source set expands to `skills_listing`, `runtime_mode`, `output_style`, hook/memory/history/meta-event sources and the others listed in Scope, and the final projection always merges adjacent user messages. Evidence: `context_prefix` stays merged into the current user message as user `<system-reminder>`; `skills_listing`, `runtime_mode`, `output_style` project to `role: "system"` after the first user prompt.

### Phase MCS2: Prompt attachment / Read-file synthetic context projection

Split ZCode-generated pure-text attachment/read-file synthetic context out of the real user `content[]` and project it to a `role: "system"` message after the user prompt.

- `buildRuntimeUserEntriesFromTurn(...)` builds from `ResolvedTurnAttachment[]` directly (not by parsing the final `content[]`) and returns one real-user message entry plus zero or more `systemReminderAttachmentEntry("prompt_attachment", rawBody)` entries; raw bodies come from `buildPromptAttachmentReminderBodies(...)`. Pasted inline images stay in the real user entry (single entry). `buildUserContentFromTurn(...)` stays as a compatibility helper for persistence/model-only paths with the old shape.
- `executeTurn(...)` adds these entries to the in-memory history (a bulk `addEntries(entries)` or `addUser`/`addAttachment` calls preserving metadata); `persistUserPrompt(...)` is unchanged, so the session store still stores the prompt and attachments as before.
- Source-less inline text attachments also become raw `prompt_attachment` entries on the new live/hydrate main path; the old persisted content-block shape is not upgraded and stays compatible. A narrow fallback is allowed only for exact ZCode-generated prompt attachment text if a real regression appears; it must never classify arbitrary user text because it starts with `<system-reminder>`.
- `prompt_attachment` is added to the MCS source set. Example: `[user "Summarize notes.", prompt_attachment "Called the Read tool with the following input: {\"file_path\":\"notes.md\"}"]` projects to `[user "Summarize notes.", system "Called the Read tool ..."]`.
- Prompt-trajectory expectation: the real user message keeps the prompt text and the `[Resource: https://example.com/ref]` URL placeholder; a following `role: "system"` message holds `Called the Read tool with the following input: ...\n\nResult of calling the Read tool:\n...`. URL/resource stays inside the real user content (not a synthetic attachment surface); the point is that Read-like synthetic context is no longer a user `<system-reminder>` block.

### Phase MCS3: Auxiliary request surface audit

Confirm that provider request surfaces beyond regular turns do not bypass projection.

| Path | Uses projection? | Migrate mid-system? | Action |
| --- | --- | --- | --- |
| regular turn | yes | yes | covered by MCS1/MCS2 |
| compact active/manual | yes | yes if history includes candidate sources | covered by `buildCompactSummaryRequestMessages(...)` / active compact projection |
| target completion verification | yes | history attachments yes; verifier prompt no | verifier prompt stays a plain transient user entry; no `goal_completion_verification` migration |
| session title | direct system prompt | no | no change |
| prompt enhance | direct short request | no | no conversation runtime attachment source; no change |

Added a compact migrated-source regression and a target-verifier plain-user regression; no production logic change in this phase. All `buildProviderRequestMessages(...)` paths get the same projection. Audit command: `rg -n "buildProviderRequestMessages|historyEntriesToModelMessages|runModelTextRequest\\(|messages:" apps/zcode-cli/packages/core/src/runtime apps/zcode-cli/packages/core/src/compact`.

### Phase MCS4: Docs + status update

Docs-only phase. States: in the first-party Opus 4.8 / mid-conversation-system enabled assumption, ZCode projects source-aware meta reminders to `messages[].role = "system"` at provider request projection; request-level userContext/currentDate/user instructions stay user `<system-reminder>` by design. The system trajectory diff, system-reminder report, overall prompt assembly Active/Future/Readiness tables and the worklog were updated; `P-27` moved out of Active into current-scope-resolved / future feature gaps.

## Final verification

```bash
pnpm --filter @zcode/core exec vitest run tests/system-reminder-source.test.ts tests/provider-request-messages.test.ts tests/prompt-attachments.test.ts tests/runtime-reminders.test.ts tests/runtime-trace.test.ts
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/core lint
```

Prompt-trajectory e2e outputs go under `apps/zcode-cli/out/mid-conversation-system-projection-<timestamp>/`.

Final provider-visible acceptance:

- `skills_listing` is `role: "system"` after the first real user prompt.
- Request-level `context_prefix` stays user `<system-reminder>`.
- `todo_reminder`, `output_style`, `date_change`, `plan_mode_exit` are `role: "system"` when triggered and no longer include `<system-reminder>`.
- Text-file `prompt_attachment` / Read synthetic context is `role: "system"` after the real user prompt.
- URL/resource and non-text attachments are not broken or dropped.
- Cache-control is on the final last non-system message.
- The provider body contains no `runtimeMessage`, `metadata.source` or internal projection markers.
- No Anthropic beta/header logic was added.

## Execution notes (outcomes)

Environment notes recorded during execution: `pnpm --filter @zcode/core ... vitest|lint` failed locally because package bins (`vitest`, `oxlint`, `tsc` shim, `tsx`) did not resolve, so tests, typecheck and dist refresh ran by invoking the root binaries directly (for example `node ../../node_modules/typescript/lib/tsc.js -p packages/core/tsconfig.json`); prompt-trajectory loads `@zcode/core/dist`, so core dist was refreshed this way before recording. Direct root oxlint matched 0 files under the current ignore/path rules.

| Phase | Evidence (prompt-trajectory out, under `apps/zcode-cli/out/` unless noted) | Result |
| --- | --- | --- |
| MCS0 | `mid-conversation-system-projection-mcs0/{sr9-runtime,sr12-attachments}/trajectories/0001.anthropic_request_body.json`; temp mock fixtures in `.../fixtures/`. Focused 3 files / 31 tests PASS. | Baseline: `skills_listing` / `currentDate` / `plan_mode active` / `output_style` are user `<system-reminder>`; text file attachment Read call/result is inside the real user `content[]`; URL resource intact. `runtime-reminders.test.ts` covers todo cadence/wording; a 10-turn TodoWrite cadence was not forced in prompt-trajectory. |
| MCS1 | `mid-conversation-system-projection-mcs1/{sr9-runtime,sr12-attachments,todo-reminder-cadence}/trajectories/0001.openai_request_body.json`; temp todo fixture in `.../fixtures/`. Focused 4 files / 58 tests PASS; core tsc PASS. | `skills_listing`, `output_style`, `todo_reminder` are `role: "system"` without `<system-reminder>`; `context_prefix` / `runtime_mode` stay user; Read attachment context still in user `content[]` (MCS2); no `runtimeMessage` / descriptor leak. |
| MCS1.5 | `tools/prompt-trajectory/out/mid-conversation-system-mcs15/system-reminder-sr9-runtime/trajectories/0001.openai_request_body.json`; no `*-non-incremental-change*`. Focused 5 files / 64 tests + `runtime-tool-loop` 59 tests PASS. | `skills_listing` and both `output_style` entries are raw `role: "system"`; `runtime_mode` and `context_prefix` stay user; no `kind` / `metadata.source` leak. `todo_reminder` and `date_change` are covered by focused tests (SR9 fixture does not trigger them). |
| MCS1.6 | `tools/prompt-trajectory/out/mid-conversation-system-mcs16/system-reminder-sr9-runtime/trajectories/0001.openai_request_body.json`. Focused 4 files / 44 tests and wider 5 files / 112 tests PASS. | Standalone producers add raw attachment entries; provider body shape stable. |
| MCS1.7 | `tools/prompt-trajectory/out/mid-conversation-system-mcs17/system-reminder-sr9-runtime/trajectories/0001.openai_request_body.json`. 11 files / 186 tests PASS. | Single canonical builder; microcompact preserves attachment source metadata. |
| MCS1.7 follow-up | `tools/prompt-trajectory/out/mid-conversation-system-no-hydrate-bridge/system-reminder-sr9-runtime/trajectories/0001.openai_request_body.json`. 8 files / 154 tests PASS. | MCS-D9: no hydrate bridge, no exact-unwrap. |
| MCS1.7 context-builder cleanup | `tools/prompt-trajectory/out/mid-conversation-system-context-builder-raw-attachments/system-reminder-sr9-runtime/trajectories/0001.openai_request_body.json`. 9 files / 170 tests PASS. | `ContextBuilder` returns `systemMessages` + raw `metaUserAttachments`. |
| MCS1.8 | `tools/prompt-trajectory/out/mcs-expanded-sources-adjacent-merge-single/test20260618-030559/system-reminder-sr9-runtime/trajectories/0001.openai_request_body.json`. 8 files / 117 tests PASS. | Expanded source set; adjacent user merge always on. |
| MCS2 | `mid-conversation-system-mcs2-20260619-015308/sr12-attachments/trajectories/0001.{openai,anthropic}_request_body.json`. Focused 3 files / 57 tests, then 3 files / 55 tests after the source-less fix, PASS. | Read-like text file attachments and source-less inline text become raw `prompt_attachment` entries; real user keeps prompt + URL placeholder; pasted images stay in the real user entry; legacy content-block shape compatible. |
| MCS3 | `mid-conversation-system-mcs3-audit/sr12-attachments/trajectories/0001.anthropic_request_body.json`. 7 files / 123 tests PASS. | Audit complete; Anthropic `system[]` holds the Read-like attachment context, real user content keeps currentDate, prompt and URL resource. |
| MCS4 | Same evidence as MCS3; 7 files / 123 tests PASS. | Docs/worklog updated. |
| MCS-FU1 | Focused `prompt-attachments` + `provider-request-messages` 2 files / 32 tests PASS; no prompt-trajectory run needed. | Failed text file attachments are dropped from the attachment list. |
| MCS-FU2 | `mid-conversation-system-fixture-fix-ucUXfD/sr11/trajectories/0004-non-incremental-change.openai_request_body.json`; `.../sr12/trajectories/0001.anthropic_request_body.json`. Adapter MCS/provider-body 3 files / 34 tests PASS. | SR11 uses `Async agent launched successfully.` with a fixed Explore inheriting the main model and separate responses for the automatic notification continuation and the later user turn; SR12 uses Anthropic / `claude-opus-4-8-cc` and the final `messages[].role === "system"` `content` is a string; top-level `system[]`, user content blocks and URL resource unchanged. |
