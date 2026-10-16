# Composer Send Funnel Telemetry (ARMS: send_input_focus / send_click / send_result)

**Status**: **Implemented**, merged via MR !2000 - three events and `send_result` end-to-end timing scope landed in the same MR (new `sendFunnelArmsTelemetry.ts`; supervisor's `awaitSendRender()` / `notifyUserInputRendered()` and `resolveSendAckSettlement()`'s `awaitRender` branch; `SessionPane` render signal effect; unit test in `v4ComposerSendFunnelTelemetry.test.ts` "Wait for Render" section). Timing scope changed from "ACK accepted" to "user message rendered to conversation history"; desktop real machine end-to-end verified ~230 ms (ACK segment 55 ~ 100 ms); **not yet released**, online percentiles to be reviewed after online launch.

**Observation**: After two weeks online, check two things per §5.4. 1) Calibrate the 30 s `render_timeout` threshold - real machine p50 is only 230 ms, 30 s is likely too wide, but need online tail evidence to narrow. 2) Check the proportion of `send_cost_ms − ack_cost_ms` (projection reflow + render segment) on low-config devices vs real machine; if this segment inflates significantly, optimization focus is on rendering rather than network.

**Known Gap**: composer slash command path not yet integrated - `dispatchSlashCommand()` missing `telemetrySeed`; existing sessions' `/compact``, `/goal`, and `emptyGoal`/`unsupportedGoal` local synchronous rejection only report `send_click` without falling through to `send_result`. When ARMS calculates success rate by `send_click_id`, this subset enters as denominator as abandonment; to be excluded separately; fix to follow up.

**Reporting Channel**: **Only Alibaba Cloud ARMS RUM custom events** (`platform.reportArmsCustomEvent`). Does not go through self-developed `/event/report`.

**Effective End**: **Electron desktop only** (`isDesktop`). Web/mobile remote control does not install reporter, does not report.

**Scope**: UI layer only (`packages/ui`). Does not modify Host/Runtime, does not change existing `send_btn` semantics.

## 1. Objectives

Fill the funnel from "seeing the input box" to "message actually sent", answering three questions:

1. Among those who clicked the input box, how many actually pressed send? (Input intent → send intent churn)
2. Among those who pressed send, how many actually sent successfully? What is the failure reason distribution? (Send channel success rate)
3. **How long from clicking send to one's own message appearing in conversation history?** (User-perceived send duration, excluding model queue and inference)

## 2. Current State & Gaps

Current chain path (all already exist, no modifications needed):

```
Click input box focus ─► recordComposerFocus() writes inputStartTime to memory only, no report
First character input ─► recordComposerTextChange() writes inputFirstCharTime to memory only, no report
Click send/Enter ─► submit() freezes sendTime no event
                     │
                     └─► sendCommand(envelope) awaits ACK
                           Accepted ─► acceptPromptSeed() ─► report send_btn (via /event/report)
                           Other ACK / Exception ─► completely silent
```

Three gaps:

- "Click input box" and "Click send" only left memory timestamps as `input_start_time` / `input_first_char_time` / `input_send_time` fields riding on `send_btn`. **Without clicking send, there is no `send_btn`, so the funnel has numerator but no denominator.**
- ACK as `rejected` / `stale` / `failed`, and `sendCommand` exception (transport-error, provider_not_ready) completely silent, only writes local bounded debug buffer of `recordV4CommandAck`, invisible to reporter.
- No field for send channel duration. `message_completion.duration_ms` is "send to round end", `time_to_first_token` is "send to first token"; both include model queue and inference, cannot measure send channel itself.

**User messages have no optimistic rendering.** `conversationProjectionStore.markCommandPending()` only writes commands to `optimisticCommands`; this field and `pendingCommands` in the full warehouse have **no UI consumers** (`reconcileOptimistic` only uses it for cleanup). User bubbles must wait for server projection replay, `snapshot.rows.window` showing `row.kind === "userInput" && row.sourceCommandId === commandId` before rendering. Therefore "ACK accepted" is far earlier than "message visible", separated by one projection push and one React render.

## 3. Design Decisions

### 3.1 Channel: Only Report to ARMS

| Decision Point | Conclusion | Reason |
| --- | --- | --- |
| Which channel | **Only ARMS**, no dual reporting to `/event/report` | Core metric is **duration distribution**; ARMS custom event `value` is numeric, natively supports avg/p50/p95/p99 with drill-down by `app_version` / `platform`; `/event/report` `event_extra_detail` are all strings, percentile requires data warehouse re-parsing |
| Effective end | Electron desktop only | `packages/web/src/main.tsx` `reportArmsCustomEvent` is no-op, Web never receives; reuse existing gating `setUiPerfArmsReporter(isDesktop ? platform : null)` |
| Relation to existing `send_btn` | `send_btn` semantics, fields, timing, channel **all unchanged** | Data warehouse already uses `send_btn` as `message_completion` pairing seed; two channels independent, this change zero impact on `/event/report` |

**Dual reporting rejected**: Same action leaving one copy in each channel, metric scopes would drift over time (one changes, other forgotten), and `/event/report` already has `send_btn` covering success path; duplicate counting would pollute existing dashboards.

### 3.2 Event Semantics

| Decision Point | Conclusion | Reason |
| --- | --- | --- |
| "Send success" moment | **User message first appears in conversation history** (`snapshot.rows.window` first shows `kind === "userInput"` and `sourceCommandId === commandId`) | Measures what user perceives as "my message sent"; ACK accepted only means Host accepted command, screen still empty |
| ACK segment separate | Yes, separate `ack_cost_ms` | When end-to-end slows, need to distinguish "upstream slow" vs "reflow+render slow"; difference gives latter |
| ACK accepted but row not returning | 30 s timeout fallback, report `status=fail` / `reason_code=render_timeout` | Unfinalized leaves dangling `send_click` polluting success denominator; 30 s far exceeds normal reflow time, reaching here means real problem |
| Report failures? | Yes, share `send_result` with success, distinguish by `status` + `reason_code` | Success rate is core metric; only reporting success = only numerator |

**"ACK accepted = success" rejected.** Under this scope real machine measured only 66 ~ 142 ms, measures command upstream round-trip to Host acceptance, not user-perceived message appearance moment — see §2 "User messages have no optimistic rendering". Original scope retained as `ack_cost_ms`, no longer `send_result` finalization signal.

**Naming**: Result event named `send_result` not `send_success`. Project convention: `xxx_success` = **success-only** events; result events with both outcomes use `xxx_result`; ARMS is new namespace, no conflict with `send_btn`, directly aligns with convention.

## 4. Target Chain

```
Click input box (real user focus)
   └─► ARMS send_input_focus                    ← New
Input content…
Click send / Enter (pass send gate, freeze sendTime + send_click_id)
   └─► ARMS send_click                          ← New
        │
        ├─ Attachment pre-upload second gate fail ─────► send_result status=fail  reason_code=attachment_not_ready
        ├─ onSendText product guard reject ─────────────► send_result status=fail  reason_code=blocked
        ├─ Queue second confirm (ACK `reasonCode=guard.heldQueueConfirmationStale`)── No finalize, wait user confirm then reuse same seed
        │
        └─► dispatchCommand → sendCommand(envelope)
              ├─ ACK accepted / duplicate ─► send_btn (existing /event/report, unchanged)
              │      └► Record ack_cost_ms, register "awaiting render" (30 s timeout), **do not finalize yet**
              │            ├─ Projection reflow shows userInput row (sourceCommandId match)
              │            │     └► ARMS send_result status=success  value=send_cost_ms (end-to-end)  ← New
              │            └─ 30 s no wait ─────► send_result status=fail  reason_code=render_timeout
              ├─ ACK rejected / stale / failed / noop ─► send_result status=fail (immediate finalize)
              └─ throw ────────► send_result status=fail  reason_code=transport_error | provider_not_ready
```

Reporting outlet:

```
supervisor ─► sendFunnelArmsTelemetry.emit()
   └─► platform.reportArmsCustomEvent(payload)
        └─► IPC PlatformChannels.ReportArmsCustomEvent
             └─► buildFinalArmsCustomEventPayload()   Inject app_version / arms_env / device_mid / platform / renderer_id
                  └─► RUM SDK sendCustom()
```

## 5. Event Definitions

Three events belong to ARMS group **`send_funnel`**. ARMS payload shape is `{ name, group, value, properties }`:

- `value` is **numeric**, main metric for this event on ARMS side;
- `properties` values allow `string | number | boolean`, main process `buildFinalArmsCustomEventPayload` uniformly `String()`-ifies before storage;
- **`undefined` properties not sent** (not written as `""`), ARMS side shows as missing attribute.

### 5.1 `send_input_focus` — Click Input Box

| Field | Value |
| --- | --- |
| `name` | `send_input_focus` |
| `group` | `send_funnel` |
| `value` | `1` (count event) |

`properties`:

| Key | Type | Meaning |
| --- | --- | --- |
| `focus_time` | number | Focus occurrence renderer clock (ms) |
| `composer_scope` | string | `session` (existing) / `draft` (new draft) |
| `talk_id` | string? | Current `sessionId`; draft state defaults not sent |

**Only reports real user focus, not programmatic focus.** `ConversationComposer` auto-focus (new task, switch session, return cursor after mount, refocus after context block removal) all go through `flushPendingFocus` calling `inputApiRef.current.focus()`, triggering same DOM focus event; implementation marks flag there, `handleEditorFocus` consumes flag and skips reporting. Existing `recordComposerFocus()` timestamp write **unaffected**, both focus types still recorded, `send_btn` `input_start_time` scope unchanged.

No time-window deduplication: one real focus = one event, literally corresponds to "click input box". Session-level deduplication by ARMS side aggregating by `talk_id`.

### 5.2 `send_click` — Click Send

| Field | Value |
| --- | --- |
| `name` | `send_click` |
| `group` | `send_funnel` |
| `value` | `1` (count event) |

`properties`: Seed frozen model/mode/plan fields (same source as `send_btn`, i.e. `buildV4ConversationPromptTelemetryExtraDetail` output) plus:

| Key | Type | Meaning |
| --- | --- | --- |
| `send_click_id` | string | This send correlation ID (uuid), pairs with `send_result` |
| `input_send_time` | number | Frozen `sendTime`, same field name and value as `send_btn` |
| `send_trigger` | string | `button` (click send button) / `shortcut` (Enter submit) |
| `composer_scope` | string | `session` / `draft` |
| `talk_id` | string? | Current `sessionId`; draft state defaults not sent |

**Report timing**: Inside `submit()` after send gate passes, `pendingRef` set, `telemetrySeed` frozen. Calls blocked by gate (empty draft, `pendingRef` occupied, attachment not ready) do not report — send button is disabled at this point, not a valid send.

**Reuse seed no duplicate report**: Queue second confirm (`clearQueueAndSend` / `keepQueueAndSend`) re-enters `submit()` with first click's `existingTelemetrySeed`, no duplicate report, ensures strict 1:1 with `send_result`.

`send_trigger` value set by send button `onClick` flag — button is `type="submit"`, shares `LexicalChatInput` `onSubmit` with Enter; DOM event order guarantees click before submit; flag read and reset each `submit()`, default `shortcut`.

### 5.3 `send_result` — Send Result (Success & Failure)

| Field | Value |
| --- | --- |
| `name` | `send_result` |
| `group` | `send_funnel` |
| `value` | **`send_cost_ms`**: Click send → this finalize moment **end-to-end** duration = finalize timestamp − `sendTime`, failure also fills |

Putting duration in `value` not `properties` is core reason for choosing ARMS channel: ARMS can directly do avg / p50 / p95 / p99 on this event, and slice by properties below.

`properties`: Same seed fields as `send_click`, plus:

| Key | Type | Meaning |
| --- | --- | --- |
| `send_click_id` | string | Correlation ID pairing with `send_click` |
| `status` | string | `success` / `fail` |
| `reason_code` | string? | Success defaults not sent; failure see table below |
| `ack_status` | string? | Original ACK status (`accepted` / `duplicate` / `rejected` / `stale` / `failed` / `noop`); no ACK defaults not sent |
| `send_cost_ms` | number | Same as `value`, redundant for direct numeric view in property dimension |
| `ack_cost_ms` | number? | Click send → receive ACK duration = ACK timestamp − `sendTime`; failure paths without ACK default not sent |
| `send_queue_confirmed` | boolean | `true` = went through queue second confirm dialog |
| `talk_id` | string? | `sessionId` known at finalize; first send not promoted defaults not sent |
| `message_id` | string? | `commandId` corresponding to ACK; failure paths not entering dispatch default not sent |

**`send_cost_ms` vs `ack_cost_ms` relation**: `send_cost_ms − ack_cost_ms` = "projection reflow + React render" segment. When end-to-end slows, check this difference first to avoid misjudging render problems as network problems.

`reason_code` values:

| Value | Trigger Point |
| --- | --- |
| `attachment_not_ready` | `attachmentsApi.prepareForSend()` returns `null`, attachment pre-upload second gate fail |
| `blocked` | `onSendText` returns `"blocked"`, product guard reject |
| `rejected` / `stale` / `failed` | ACK corresponding status |
| `render_timeout` | ACK `accepted` / `duplicate` but 30 s projection never reflows corresponding `userInput` row |
| `transport_error` | `sendCommand` throws exception (non-provider not ready) |
| `provider_not_ready` | `sendCommand` throws provider not ready exception |
| `composer_error` | `submit()` catches other exceptions |

`attachment_not_ready` and §5.2 "attachment not ready no `send_click`" not contradictory: former is click time `hasUnreadyAttachments` already true, button disabled, never entered `submit()` body; latter is click time attachment appears ready, `send_click` already reported, then `prepareForSend()` fails. Latter not finalizing leaves dangling `send_click` polluting success denominator.

**`noop`归口**: `CommandAck.status` has `noop` (command deemed no-op by Host). Not separate `reason_code`, unified as `failed` — from "did message send" user perspective it didn't; original value retained in `ack_status=noop`, drill down when needed.

**Non-finalizing ACK**: `ack.reasonCode === "guard.heldQueueConfirmationStale"` is queue second confirm signal, means "wait user decision then reuse same seed to resend", not terminal. Must **not** call `settleSendResult()`, also **must not** register awaiting render — once finalized, first-wins would eat subsequent real outcome. This check precedes `ack.status` (this ACK's status itself non-`accepted`).

`ConversationSendFailureReason` and ACK mapping consolidated in `resolveSendAckSettlement()` pure function (`conversationTelemetrySupervisor.ts` export), `dispatchCommand` only calls, no own branches. **This function's return semantics adjusted**: `accepted` / `duplicate` no longer return terminal, instead return `{ kind: "awaitRender" }`, caller registers awaiting render; other ACKs still return `{ kind: "settle", status: "fail", … }` immediate finalize.

### 5.4 Await Render Mechanism

When ACK is `accepted` / `duplicate`, supervisor registers awaiting render record keyed by `commandId`, containing seed, `ackCostMs`, and a 30 s timer:

| Trigger | Action |
| --- | --- |
| `snapshot.rows.window` shows `kind === "userInput" && sourceCommandId === commandId` | Finalize `status=success`, `send_cost_ms` = render timestamp − `sendTime` |
| 30 s timer fires first | Finalize `status=fail` / `reason_code=render_timeout`, `send_cost_ms` = 30000 |
| `dispose()` | Clear all timers, no backfill |

Both paths **first-wins**: either finalizes immediately deregisters record and `clearTimeout`, existing `settledSendClickIds` dedup adds another layer, guarantees one `send_click` → one `send_result`.

Render signal emitted by `SessionPane` in projection update commit phase (`useEffect` depends on `snapshot`): iterate all `userInput` rows in `snapshot.rows.window`, pass each `sourceCommandId` to supervisor; supervisor internally filters by awaiting render map (`Map.get` O(1)), unregistered `commandId` ignored, so history message backfill, session switch reload don't false trigger.

**Cannot just take last `userInput`.** After user message reflows, background result rows (`origin=backgroundResult`) may immediately insert at window tail; only looking at tail would miss user's own row, misjudge normal send as `render_timeout`. Full window scan cost same as existing `hasPluginReferenceUserRows()`, runs once in effect.

**Why `useEffect` not store subscription callback**: `useEffect` executes after DOM commit, user bubble actually painted to screen; store callback only means data arrived, React not yet rendered. Scope is "rendered to conversation history", must take post-commit.

**Duration scope**: `send_cost_ms` from **first** click send. If queue second confirm appears, user dwell time included, marked `send_queue_confirmed=true`, pure channel duration analysis should exclude this subset (ARMS filters by this property).

**Deduplication**: By `send_click_id` first-wins, one `send_click` → one `send_result`. `duplicate` ACK same as `accepted` enters awaiting render — command indeed exists on Host side, user perspective still expects to see own message, wait for row then record `status=success`.

**Dangling samples**: Two sources. One, user cancels queue second confirm dialog — that `send_click` never gets paired `send_result` — real user abandonment behavior, ARMS identifies by `send_click_id` no pair, no backfill. Two, slash command path not yet integrated (see "Known Gap" at top), implementation gap not user behavior, exclude when calculating success rate; this condition voids once `telemetrySeed` integrated.

## 6. Non-Reporting Scenarios

Below scenarios **must not** produce these three events, consistent with "no fabricated user action" principle:

- Non-desktop (Web, mobile remote control): reporter not installed, whole group silent.
- Background automation (Off-Peak, automation): doesn't go through composer, seed has no `sendClickId`, skips at finalize.
- Queue promotion (queued message activated as current turn): not new user click.
- Programmatic auto-focus: see 5.1.

## 7. Failures Must Not Break Main Flow

ARMS is observability chain, same structure as existing `uiPerfArmsTelemetry`: `emit()` `try/catch` wraps sync exceptions, and returned Promise gets `.catch()`, failure only `logger.warn`, **never blocks send main chain**. Reporter not installed (Web / uninitialized) direct `return`, no queue no cache.

Three events all synchronous fire-and-forget, not through `enqueueReport` serial queue — that queue is `/event/report` channel order guarantee, ARMS has no such need (same as existing `reportUiFirstToken` etc. ARMS events).

## 8. Implementation Locations

| File | Changes |
| --- | --- |
| `packages/ui/src/lib/sendFunnelArmsTelemetry.ts` | **New**. Exports `SEND_FUNNEL_ARMS_GROUP` and three event name constants, `setSendFunnelArmsReporter()` / `clearSendFunnelArmsReporterForTest()`, `reportSendFunnelInputFocus()` / `reportSendFunnelSendClick()` / `reportSendFunnelSendResult()`. Structure mirrors `uiPerfArmsTelemetry.ts`. `SendFunnelReasonCode` adds `render_timeout`, `reportSendFunnelSendResult()` adds optional `ackCostMs` → property `ack_cost_ms` |
| `packages/ui/src/Root.tsx` | Existing `useEffect` adds `setSendFunnelArmsReporter(isDesktop ? platform : null)`, cleanup sets `null` (parallel to `setUiPerfArmsReporter`) |
| `packages/ui/src/v4/telemetry/conversationTelemetrySupervisor.ts` | `recordComposerFocusClick()` / `recordSendClick()` / `settleSendResult()` now call ARMS helpers above, **no longer `enqueueReport`**; `resolveSendAckSettlement()` returns `await-render` / `settle` two states; new `awaitSendRender()` (register awaiting render + 30 s timer) and `notifyUserInputRendered(commandId)` (render signal entry); `dispose()` clears all awaiting render timers |
| `packages/ui/src/v4/ConversationComposer.tsx` | Wiring unchanged (method signatures unchanged) |
| `packages/ui/src/v4/SessionPane.tsx` | ACK branch follows `resolveSendAckSettlement()` new return: `awaitRender` calls `awaitSendRender()`, `settle` calls `settleSendResult()`; new `snapshot`-dependent `useEffect`, iterates all `userInput` rows in `snapshot.rows.window`, passes `sourceCommandId` to `notifyUserInputRendered()` |

`send_click_id` generation reuses `globalThis.crypto?.randomUUID?.()` + fallback (same as `codingPlanFunnelTelemetry.createPurchaseFunnelId`).

## 9. Test Requirements

Per AGENTS.md, write tests first then implement.

- `packages/ui/test/v4ComposerSendFunnelTelemetry.test.ts`: Assert objects are **ARMS payload** (`name` / `group` / `value` / `properties`), covering — real focus reports / `recordComposerFocus` remains zero report, `send_click` and `send_result` `send_click_id` pairing, `send_trigger` two values, nine failure `reason_code`, `send_click_id` dedup first-wins, `value` = `send_cost_ms` and queue confirm scope, background tasks no report, reporter not installed silent, dispose silent, and `resolveSendAckSettlement()` ACK mapping (including `noop`归口 and queue second confirm no finalize).
- **Await Render Dedicated** (core guard for new scope):
  - ACK `accepted` does **not immediately** report `send_result`;
  - Only reports after matching render signal received, and `value` / `send_cost_ms` = **end-to-end** duration (render timestamp − `sendTime`), `ack_cost_ms` = ACK segment;
  - `duplicate` and `accepted` same awaiting render path;
  - 30 s no wait → `status=fail` / `reason_code=render_timeout` / `send_cost_ms=30000`;
  - Render signal and timeout first-wins both ways (both directions tested);
  - Unregistered `commandId` render signal triggers no report (history backfill / session switch reload);
  - Queue second confirm ACK neither finalizes nor registers awaiting render;
  - After `dispose()`, timer advancing to 30 s asserts zero reports (fake clock).
- **`/event/report` Zero Pollution**: Must assert these three actions **completely do not call** `platform.reportTelemetryEvent`, and existing `send_btn` timing and fields unchanged — regression guard for "don't touch `send_btn`" and "only ARMS" constraints.

**Not in legacy↔V4 diff parity**: `conversationTelemetryParityScenarioDefinitions.ts` `minimumReportInventory` named "minimum" but actually `toEqual` exact match in `conversation-session-telemetry-parity-all-cases.test.ts`, and same expectation constrains both legacy and V4 bridge variants. These three events only produced by V4 `ConversationTelemetrySupervisor`, legacy replay driver has no supervisor, cannot produce corresponding events — adding to expectation would make legacy variant necessarily fail. Parity's job is prove old/new final outlets equivalent, V4 unique new events not in scope, covered by unit tests above. That table constrains `/event/report` outlet, these three events don't use that channel, naturally out of range.

This doesn't create telemetry blind spot: entire repo only has `packages/ui/src/v4/ConversationComposer.tsx` as send entry, legacy `queuePromptTelemetry` helpers now only referenced by V4 supervisor and that replay driver, no un-instrumented real send paths.