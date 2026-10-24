# User onboarding telemetry spec

Date: 2026-09-18. Status: wired into the onboarding component and the common reporting chain; real client and
receiver await manual acceptance.

## Goals and events

Record each onboarding exposure and the choices at its end, reusing the common business telemetry chain.

| Event               | element_name      | event_region   | event_type | event_text                                                                       |
| ------------------- | ----------------- | -------------- | ---------- | -------------------------------------------------------------------------------- |
| Onboarding exposure | onboarding_expose | app.onboarding | expose     | empty string                                                                     |
| Onboarding end      | onboarding_end    | app.onboarding | ck         | Localized label of the button or close entry at the time of the action; required |

`event_element` in the telemetry table maps to the existing request field `element_name` (call parameter
`elementName`); no synonym field is added. The end event's event_text must be the button label the user saw when
clicking, using the same i18n translation result as the button, not hardcoded Chinese, English or a translation
key; it is captured together with the selection snapshot so switching language during the async save cannot make
the text inconsistent. Action statistics rely on the fixed English `exit_action`.

The close entry is an icon button; its event_text reuses the `occupationOnboarding.close` translation of its
title / aria-label: currently “退出引导” in Chinese and "Exit onboarding" in English. Esc and the onboarding
shortcut closing it actively use the same close label, never an empty string or key name.

- First automatic display, later opening from Settings via “引导” (onboarding), manual opening by shortcut, and
  automatic re-display under existing rules each report one exposure when the onboarding actually becomes visible;
  not limited to first use of the app. Async decisions, prefill, re-render, step switches and going back do not
  re-report. Explicitly reopening after closing counts as a new exposure; clicking an entry without actual display
  reports none.
- On page 3, clicking start or skip reports end once, when the preference save succeeds and onboarding ends. The
  selection snapshot is captured at click time and must not be inferred from conservative defaults after saving or
  from the local record.
- A failed save stays in onboarding and reports no end; a successful retry reports exactly one. A failed local
  record append does not affect an end event that already succeeded.
- Skip on the first two pages only moves to the next page and triggers no end; a skipped single-choice page is
  recorded empty, and after going back and reconfirming the new answer is used.
- Top-right X / Esc / onboarding shortcut closing all report end with exit_action `close`, carrying the selection
  snapshot at close time and the current step; the existing semantics of exiting directly without saving settings,
  writing a record or marking completion are kept. The report is initiated before exit and does not wait for the
  network. Closing the app, a crash or a non-user unmount does not fabricate a close.
- One onboarding produces at most one end; start / skip / close share end de-duplication; the existing behavior of
  disabling close while saving is unchanged. The gap between exposure and end counts samples that did not
  successfully receive an end event, possibly including abnormal interruption or report failure.
- Telemetry failure must not block onboarding or configuration saving; it follows the common upload retry policy,
  with no extra retry in the business layer.

```text
Onboarding actually shown -> expose (once)
    -> work direction -> UI mode -> work-assistant preferences
         skip ----> next page     |
                        start / skip: capture selection snapshot
                               |
                         settings save
                      failure /          \ success
                 stay in onboarding       end (once)
                                          -> existing end flow
X / Esc / onboarding shortcut closing on any page
    -> capture existing selections + current step
    -> end(close, once, no network wait) -> exit directly, no settings or record saved
```

## event_extra_detail

The exposure event uses an empty object. The end event always contains these fields:

| Field                                  | Logical value        | Meaning                                                                       |
| -------------------------------------- | -------------------- | ----------------------------------------------------------------------------- |
| work_direction                         | enum below / null    | Current work direction of a shown page; null if skipped and not re-chosen     |
| ui_mode                                | work / code / null   | Office / coding; null if not shown, or skipped and not re-chosen              |
| proactive_task_recommendations_enabled | boolean / null       | Checked state of proactive task recommendations, shown only in office mode    |
| workspace_memory_enabled               | boolean / null       | Checked state of workspace memory                                             |
| claude_code_history_migration_selected | boolean / null       | Checked state of migrating session data; does not mean the migration finished |
| exit_action                            | start / skip / close | End entry                                                                     |
| exit_step                              | 1 / 2 / 3            | Page at the end; 3 for start / skip, any page for close                       |

Modes are mapped only at the telemetry boundary: internal `office -> work`, `coding -> code`; the modes in
settings, store or record are not renamed.

Preference fields: shown and checked is true, shown and unchecked is false, not shown is null. When coding mode or
a skipped mode page hides the recommendation option, the recommendation field is null and not counted as actively
turned off. Default or prefilled checks count in the final state and do not mean an active click. Clicking skip on
page 3 still uploads the state of the three options at that time rather than uniformly empty, and does not mean
those options were applied.

close also records the current selection without requiring the current page to click next: closing on first
arrival at page 1 uploads the defaults/prefill or manual choice shown on that page, with mode and the three
preference fields null; closing on page 2 may upload the work direction and the current mode, with not-yet-shown
preferences null. A page visited and returned to keeps this session's choice, and which pages were shown cannot be
inferred from exit_step alone. When going back to change the mode, an old preference snapshot inconsistent with
the new mode is invalidated, and preferences not confirmed under the new mode are null. All of this is a selection
snapshot and does not mean saving or enabling succeeded.

**Transport format:** the existing `TelemetryEventPayload.eventExtraDetail` is `Record<string, string>`. This
interface is reused and every value is encoded as a string: booleans `"true"` / `"false"`, empty `"null"`, page
numbers `"1"` / `"2"` / `"3"`. Empty fields are not omitted, JS undefined is not sent, and the whole object is not
JSON-serialized a second time. The logical types above explain meaning; real queries compare strings. If native
boolean/null is adopted later, the common interface must be evaluated and upgraded as a whole, not force-cast for
this event alone.

### Work-direction mapping

The first column is the UI copy (zh-CN) and stays as is; the reported enum does not change with display language.

| UI copy (zh-CN)    | Internal occupation | work_direction                                 |
| ------------------ | ------------------- | ---------------------------------------------- |
| 软件开发/数据/AI   | developer           | software_data_ai                               |
| 创业/自由职业/OPC  | independent         | entrepreneurship_freelance_opc                 |
| 测试/运维/安全     | infrastructure      | qa_operations_security                         |
| 产品/项目/解决方案 | product             | product_project_solutions                      |
| UI/UX/视觉设计     | design              | ui_ux_visual_design                            |
| 学生/教师/科研     | student             | education_research                             |
| 金融/财务/咨询     | finance             | finance_accounting_consulting                  |
| 自媒体/内容创作    | creator             | media_content_creation                         |
| 运营/电商/客户服务 | operations          | business_operations_ecommerce_customer_service |
| 市场营销/品牌/公关 | marketing           | marketing_brand_pr                             |
| 法律/行政/人力资源 | legal               | legal_administration_hr                        |
| 其他职业           | other               | other                                          |

The internal occupation enum is not modified. A display-copy or language change must not change the reported enum.
`other` only means an explicit choice of another occupation and cannot stand for not answered.

## Common identity fields and chain

Both events must carry top-level `user_id` and `device_mid` through the common layer, not inside
event_extra_detail.

- user_id: keep the common layer's current account identity loading; with no account identity keep the empty
  string, never forge a user ID or substitute the device ID. Implementation and acceptance must check that
  requests of a logged-in user have the real account ID and that the field is still present when anonymous.
- device_mid: reuse the persisted common device identifier in telemetry-state, provided by
  `ensureTelemetryDeviceMid`; no onboarding-specific ID, no reuse of event_id, no switch to
  `platform.getDeviceId()`. The deviceMid source in the local onboarding-record doc differs from the common
  telemetry device identifier and must not be mixed.
- Each event uses the common event ID and common context; no separate reporting interface is added.

```text
OccupationOnboarding
  -> reportAppTelemetryEvent / usePlatform
  -> IPlatformService.reportTelemetryEvent
  -> Desktop common TelemetryCore
       + current user_id
       + persisted device_mid
  -> existing event/report request
```

Request example (relevant fields only, identity values are placeholders; `event_text` “开始使用” = "Start"):

```json
{
  "element_name": "onboarding_end",
  "event_region": "app.onboarding",
  "event_type": "ck",
  "event_text": "开始使用",
  "user_id": "<current-user-id>",
  "device_mid": "<shared-telemetry-device-id>",
  "event_extra_detail": {
    "work_direction": "product_project_solutions",
    "ui_mode": "work",
    "proactive_task_recommendations_enabled": "true",
    "workspace_memory_enabled": "true",
    "claude_code_history_migration_selected": "false",
    "exit_action": "start",
    "exit_step": "3"
  }
}
```

## Boundary with the local record and multi-end

Skip semantics of the local record continue to follow the [onboarding record spec](../onboarding-record-spec.md):
skipping a preference page writes null and settings fall back to conservative defaults. This event records the
choices the user saw at the end; the purposes differ and the record cannot be uploaded in place of this event. The
record's uploadState upload queue is not implemented in this phase.

The UI calls through the existing platform abstraction; Web/mobile use their own adapters' capability and never
access the desktop bridge directly or create a new Host/runtime; the desktop continuous and mobile replayable
message flows are unchanged. Layout, interaction, theme, i18n and Windows/macOS/Linux configuration behavior stay
as is.

## Implementation order and acceptance

Write the following scenario tests first, then wire the events, then verify the runtime request:

1. All 12 occupation mappings complete; office/coding map to work/code; a skipped single-choice page sends the
   string null, and other occupation is other.
2. The three work-mode switches each support check/uncheck; in code mode the recommendation is null; hidden options
   do not leak old values after a mode switch.
3. start and page-3 skip both keep the click-time snapshot; skip triggers no migration, and checking migration does
   not mean the migration succeeded.
4. First automatic display and Settings/shortcut opening both produce an exposure; skip, back and repeated render
   on the first two pages produce no end or duplicate exposure; a failed save reports no end and a successful
   retry reports once; repeated clicks do not repeat the report; an explicit reopen produces a new exposure.
5. Closing with X / Esc / onboarding shortcut on each of the three pages reports close exactly once with the right
   exit_step; shown choices are kept and unshown fields are empty; going back and switching mode leaks no stale
   preference; no settings/record is written, no migration triggered, no completion marked. Closing the app or
   unmounting does not fabricate close; a report failure does not block exit.
6. In the real common request body verify both events contain user_id and device_mid; the logged-in account is
   right and anonymous keeps an empty user_id; both events on one device have the same device_mid and it is stable
   across restarts. Mask real identities in logs/captures.
7. Run pnpm typecheck, pnpm lint and related unit tests; verify desktop work/code, light/dark themes and the
   mobile adapter are unaffected. Cross-platform or runtime verification that cannot be done is recorded
   explicitly and not replaced by static reading.
8. In Chinese and English, event_text of start / skip / close end events is non-empty and equals the actual button
   copy or close label at the time (“退出引导” / Exit onboarding); exit_action does not change with language.
   Switching language during an async save cannot change an already captured event_text.

## Landing points and regression cases

`OccupationOnboarding` stays the sole owner of selection state; `useOnboardingTelemetry` only records, in a layout
effect, the steps actually shown, the current mode and same-session end de-duplication, and persists no second copy
of the answers. The save entry freezes the snapshot first and sends end after settings succeed; close sends
directly. After the end the steps are reset so a reopen does not inherit the previously shown range.

| Case    | Setup and action                                          | Assertions                                                                                   | Automation location                      |
| ------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| ONBT-01 | First auto/manual open, StrictMode, page switches, reopen | One exposure per actual open, none when not shown                                            | UI occupationOnboardingTelemetry.test.ts |
| ONBT-02 | Three-step selection then start/skip, failed save retry   | One end after success; click-time answers and language kept; migration intent is not success | same                                     |
| ONBT-03 | Close on any page, go back and change mode then close     | close and page number correct, unshown/invalid preferences empty, nothing saved              | same                                     |
| ONBT-04 | Common Core reports anonymous/logged-in events            | Top-level user_id/device_mid; device identifier unchanged after rebuilding Core              | services telemetryService.test.ts        |
| ONBT-05 | Real desktop onboarding reopened, close/start/skip        | Actual request body and receiver events, identity and fields complete                        | manual verification by the user          |

At the user's request E2E is not an acceptance item for this change: code is verified with component interaction
tests and common-Core request-body tests; the real client and production receiver are manually verified by the user
and not yet accepted. Web/mobile keep reusing the original platform adapter capability and no separate upload exit
was added.
