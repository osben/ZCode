# Conversation Telemetry Legacy/Current Differential Regression Plan

This document defines the runtime telemetry differential between `z-code-2` and the V4 conversation main path, and the automated regression contracts kept after the differential is confirmed. The goal is not a one-off manual capture: legacy-compatible behavior becomes repeatable golden, integration and Electron E2E tests, so a later conversation refactor cannot silently delete telemetry or its business triggers.

## Summary

| Field | Decision |
| --- | --- |
| Nature | Compatibility restore and regression protection after the V4 conversation refactor |
| Baseline | Actual desktop runtime behavior of `~/workspace/z-code-2`; confirmed V4 spec exceptions win |
| Surfaces | V4 composer, session pane, assistant feedback, quota banner, error banner |
| Reporting ends | `/event/report` and ARMS custom events |
| Client scope | Desktop `desktop-continuous` reports; Web/mobile only verify no-op and isolation |
| Provider scope | Generic telemetry uses any scripted provider; quota uses the Start Plan equivalence class; the official-build safety-check case uses the `zcode-plan` endpoint class |
| Non-goals | Purchase product/cycle/payment/result, launch performance, input lag, ARMS global stability/resource/network |

## Clarification record

| Round | Question | Confirmed | Fixed boundary |
| --- | --- | --- | --- |
| 1 | Run legacy and current apps on the same case and compare final reports? | Yes | Runtime differential, not static code intersection |
| 2 | Must dynamic values (timestamps, versions) be equal? | No | Field presence, type and relations must be right; only explicit dynamic values are normalized |
| 3 | Build covering cases first? | Yes | Case catalog and pruning precede the differential runner and E2E code |
| 4 | Restore the purchase flow? | No, conversation entry points only | Quota verifies only the conversation banner, submit guard, opening the Upgrade panel and context handoff |
| 5 | Must GLM be used? | No | Core telemetry is provider-neutral; only quota and the official-build safety check use business equivalence classes |
| 6 | Must regression code remain? | Yes, unit or E2E | Every accepted case binds at least one automated contract layer |

## Scope

### Must compare and regress

`/event/report`: `send_btn`, `message_completion`, `agent_step`, `context_compaction`, `assistant_message_feedback`.

ARMS: `perf_ui_first_token`, `perf_ui_message_complete`, `perf_ui_turn_breakdown`, `perf_ui_stream_stall`, `perf_ui_tool_call_detail`, `plan_request`, `plan_ttft`, `chat_error_banner`.

Conversation business entries:

- Assistant feedback: like, dislike, toggle none, failure rollback, persistence after reopen.
- Session quota banner: display, dismiss, submit guard, entitlement refresh, opening the existing Upgrade panel.
- Official-build safety check: bounded recovery inside a model call (official builds only).

### Explicitly excluded

- `purchase_product_select_ck`, `purchase_billing_cycle_select_ck`, `purchase_pay_ck`, `purchase_result` and payment backend behavior. Purchase telemetry was not lost in the V4 conversation refactor.
- `perf_ui_launch_*`, `perf_ui_input_lag`, ARMS main stability/resource/network.
- Real Web/mobile network reporting.
- Real model output quality, provider SLA, live-account entitlement correctness.
- Back-filling historical sessions, or writing telemetry state into snapshot/transcript.

## State and evidence chain

```text
case-local provider fixture / synthetic fault
                   |
                   v
        +----------+----------+
        |                     |
        v                     v
 legacy z-code-2        current z-code V4
 isolated E2E home      isolated E2E home
        |                     |
        +----------+----------+
                   |
          capture final boundaries
          |                    |
          v                    v
 /event/report HTTP body   ARMS main sendCustom
          |                    |
          +---------+----------+
                    v
          normalize explicit dynamics
                    |
                    v
 inventory -> keys -> types -> values -> relations -> order
                    |
                    v
        approved legacy golden + regression tests
```

| State/fact | Authoritative owner | Mirror/cache | Regression evidence |
| --- | --- | --- | --- |
| session/turn/tool/terminal | CLI V4 runtime | host live fact, renderer supervisor | provider replay, protocol fact, final payload |
| prompt seed/sourceCommandId | renderer workspace supervisor | memory only | command ACK, talk/message relation, exactly-once |
| foreground session refs | renderer workspace supervisor | pane visibility refs | UI/pane state, ARMS present/absent |
| `/event/report` body | telemetry service final fetch | no business persistence | Electron `net.fetch` mock calls |
| ARMS custom body | desktop main IPC bridge | E2E-only bounded buffer | `armsRum.sendCustom` call arguments |
| feedback | assistant row + CLI persistence | UI optimistic state | command ACK, row, reopen, event body |
| quota | usage entitlement service + session provider/error | hook-local dismiss state | banner DOM, composer guard, dialog context |

## State dimensions and equivalence classes

| Dimension | Included values/classes | Pruning |
| --- | --- | --- |
| prompt admission | draft create ACK, direct, queued, promotion, rejected | rejected produces no send; promotion merges with the original command |
| terminal | success, failed, interrupted, stop without terminal | stop without terminal is a zero-report negative case only |
| stream shape | text, thought, generation, tool success, tool failed, permission wait, parented child chunk | tool names not permuted; lifecycle/perf classes represent them |
| visibility | foreground, background, pane closed, split pane | multiple panes of one session collapse to one; different sessions can be foreground independently |
| delivery | live, duplicate live, initial, hydration, recovery | only live can produce a fact |
| timing | negative first token, stall 3000/3001, tool clears stall, permission wait | exact boundaries use fake clock / recorded stream; not every duration value |
| model network | started, completed, failed, retry_scheduled, stream_stalled | never inferred from accepted/queued/apiRetry |
| provider | generic, custom hostname, Start Plan, `zcode-plan` endpoint | not permuted by model name or vendor brand |
| compaction | success, failed, interrupted, non-terminal, duplicate | terminal status gets golden; foreground/background gets a representative E2E |
| error banner | visible, suppressed, same-key duplicate, new key, 3007 | dedupe within a mount; invisible does not report |
| workspace | local, same path with different identity/remoteSession, service generation replacement | path display is not mixed with identity isolation |
| client | desktop continuous, web remote replayable | Web/mobile only get no-op / not-subscribable negative proof |

## Pruning decisions

| ID | Pruned combination | Invariant/reason | Representative coverage |
| --- | --- | --- | --- |
| TDP-P01 | all concrete providers x all models | conversation telemetry has no business guard on model brand | generic + custom hostname; quota/official-build safety-check equivalence classes |
| TDP-P02 | theme x locale x terminal | does not change the event state machine; locale/timezone fields covered by builder golden | one E2E locale, context golden |
| TDP-P03 | OS x every Electron case | payload platform fields owned by the shared normalizer | current-platform E2E + shared unit test / CI platform matrix |
| TDP-P04 | all tool-family permutations | telemetry only cares about lifecycle, permission, perf allowlist, parent/child relation | tool success/fail/permission/parented representatives |
| TDP-P05 | Web/mobile repeating all desktop cases | legacy behavior does not report from Web/mobile networks | reporter no-op + telemetry subscription guard |
| TDP-P06 | purchase product/cycle/pay/result | purchase implementation is not missing; not part of the conversation-refactor restore | stop at the quota dialog context handoff |
| TDP-P07 | background UI ARMS, background compaction | confirmed legacy behavior is zero reports | dedicated negative case |
| TDP-P08 | inferring `plan_request` from accepted/queued | the V4 spec explicitly consumes only real model-network states | network status case + auxiliary states report zero |

## Accepted regression cases

`TDP` cases are the atomic execution cases of `TEL01-TEL09`. On 2026-07-18 each of TDP01-TDP19 was run on two real Electron instances (legacy and current) with the same controlled fact sequence, comparing the final `/event/report` HTTP body and the main ARMS payload. "Verified" here is not formal E2E promotion: the new differential specs remain in pending review.

| ID | TEL | Setup / Action | Key assertions | Automated contract |
| --- | --- | --- | --- | --- |
| TDP01 | TEL01 | First send from a new draft; plain-text completion after create ACK | send keeps the original action time; talkId is fixed after the ACK; send/completion/step share sourceCommandId; one each | Electron E2E + full-payload golden |
| TDP02 | TEL01 | Two consecutive plain-text turns in one session | same talkId, different messageId; second turn's step/count does not accumulate the first | legacy/current differential Electron E2E; reuse the TEL01 fixture |
| TDP03 | TEL03 | Submit a queued prompt while running, then promotion | send only once at first admission; promotion does not resend; no completion before terminal | controlled-stream E2E + supervisor fake clock |
| TDP04 | TEL01 | Prompt success with usage/model request/text terminal | completion success with full legacy fields; token/model/provider/hostname correct | builder golden + service integration |
| TDP05 | TEL01 | Prompt failed; terminal with/without usage and error detail | fail fields, empty strings and accumulated usage match legacy; no success-only field pollution | full-payload golden |
| TDP06 | TEL01 | Interrupted terminal; separately, stop with no terminal | interrupted completion per legacy; no synthesized completion without terminal | full-payload golden + controlled-stream E2E |
| TDP07 | TEL05 | thought -> text -> terminal | reasoning and generation step order, loop_index, duration, tail finalize correct | fake-clock golden |
| TDP08 | TEL05 | tool-first, tool success, tool failed, permission wait, parented child text/thought, terminal | first main tool can be first token; tool step status/waiting; completion summary; tool detail only with perf; parented text is not generation but keeps legacy TTFT/stall; parented thought keeps legacy reasoning/TTFT/stall | fake-clock golden + representative tool E2E |
| TDP09 | TEL02 | A streams, switch to B, close A pane, exceed keep-warm, A terminal, reopen | completion/step once each in background; UI ARMS zero; reopen initial does not back-fill | controlled-stream Electron E2E |
| TDP10 | TEL05 | text/tool/no-token first token, 3000/3001ms gap, tool clear, split pane | negative first token clamps to 0; legacy `-1` without token still mirrors UI value=0 but sends no plan TTFT; 3000 not reported, 3001 reported; tool clears tracker; multiple panes of one session report once | fake-clock + recorded-stream Electron E2E |
| TDP11 | TEL04 | compact success/failed/interrupted/non-terminal/duplicate; custom model; compactReason only; foreground/background switch | full payload for the three terminals; custom model uses legacy UI encoding; compactReason does not back-fill legacy reason; non-terminal/duplicate/background add zero events | full-payload golden + representative Electron E2E |
| TDP12 | TEL05/TEL09 | Five real model-network statuses, arriving foreground and background; auxiliary accepted/queued/apiRetry | `plan_request` count, status/value/redacted hostname correct; auxiliary states report zero | full-payload golden + host live integration |
| TDP13 | TEL05 | plan TTFT normal, negative, provider missing, background | only valid foreground values report; negative / missing provider / background do not | fake-clock golden |
| TDP14 | TEL06 | Ordinary error visible, suppressed by quota/local error, same-key rerender, new key | reported once when actually visible; suppressed zero; same mount same key once; trace/detail truncation and types correct | component test + Electron E2E |
| TDP15 | TEL07 | like, dislike, same-reaction toggle none, command failure, reopen | immediate legacy payload; entityId is messageId; failure rolls back; success persists | component + command/projection integration + reopen E2E |
| TDP16 | TEL08 | Start Plan quota snapshot/error triggers banner; dismiss, blocking/non-blocking, refresh, Upgrade | thresholds/priority match legacy; dialog really opens; `upgradeSource=session_quota_alert`; downstream purchase events not verified | state/component integration + Electron E2E |
| TDP17 | TEL06 | Built-in Start Plan model call returns 3007 (official-build safety-check rejection) | official builds only; assertions follow the official-build safety-check spec | adapter/service integration + fault-stream E2E |
| TDP18 | TEL09 | live coexists with duplicate/initial/hydration/recovery; renderer reload | live exactly-once; other sources report zero; reload does not replay historical seed/terminal | gateway/service integration + Electron reload E2E |
| TDP19 | TEL09 | Same workspacePath with different identity/remoteSession; service generation replace; Web reporter | supervisor isolation, old generation destroyed; Web/mobile reporter no-op and cannot subscribe to the real feed | service integration + desktop/remote boundary test |

## Provider and account policy

- TDP01-TDP15 and TDP18-TDP19 use a local scripted provider by default; no real account, API key or GLM.
- Custom-provider cases need only an endpoint hostname/path fixture, proving only the hostname is reported and path/query never leak.
- TDP16 uses the Start Plan provider ID and an entitlement fixture; no real quota account.
- TDP17 uses a provider fixture whose endpoint ends with `/zcode-plan` or `/zcode-plan/anthropic`; the safety-check config and 3007 are simulated by a local service. The model name need not be GLM (official builds only).
- Real accounts/models are only for an optional production smoke after all automation passes; they are not part of the CI contract.

## Two-version capture and comparison contract

### Isolated runs

Legacy and current use separate `ZCODE_E2E_HOME_DIR`, network capture, artifact and runtime log directories. A paired case runs serially so ports, protocol registration, provider replay and machine load do not interfere. Each artifact records:

- legacy/current git SHA, build version and case ID.
- fixture SHA and timing strategy.
- OS, locale, timezone, screen size.
- the captured target-event inventory.

### Capture points

- `/event/report`: final request body at the Electron `net.fetch` mock.
- ARMS renderer: the existing bounded ring buffer of the test build, to locate differences before the builder/IPC.
- ARMS main: E2E-only bounded capture before `armsRum.sendCustom`, comparing the final arguments after main fills the common dimensions.
- The legacy repo gets only temporary E2E instrumentation, restored clean after the run; test hooks are not treated as legacy behavior changes.

Production builds must not create capture globals, persistent buffers or read IPC. Test capture must never really send to online `/event/report`/ARMS.

### Normalization allowlist

Values may differ but fields must exist with the right type:

- event/request UUID, capture timestamp.
- `app_version`, build/git SHA.
- `device_mid`, `renderer_id`.
- Opaque IDs: session/message/turn/tool/request.
- Positive wall-clock durations from two independent processes, including tool `total_ms` and recorded-stream `stall_ms`; formulas are still verified per side: `> 3000ms`, `value=metric_value`, parts not exceeding total.
- Compaction runtime context token watermark: runtime prompt/template differences can cause small token differences; the field, non-negative type, `post/pre` ratio and `true_post` relation are still verified. Ordinary main-turn `message_completion` usage is not normalized, and sidecar/title leakage still fails.

IDs are not deleted; they map on first appearance to stable aliases (`SESSION_1`, `MESSAGE_1`, `TOOL_1`) so cross-event relations are still verified. `input_id`, `query_id` and `request_id` use separate alias spaces and each is verified stable between started/completed; the three are not compared to each other. Legacy generated UI message/input/query IDs separately, while the approved V4 command protocol uses the same `sourceCommandId` as the input/query anchor; this is an opaque-value generation change, not a field or trigger change.

Unknown fields do not join the allowlist automatically; a new normalization rule must update this spec with the reason.

These differences always fail:

- Missing, duplicate or unexpectedly added events in the target scope.
- Different key set, field names, or string/number/boolean types.
- Different `""`, missing, `null`, fixed zero values.
- Different status/result/model/provider, event region/type/text.
- Different talk/message/tool/sourceCommand relations or stable business order. In legacy, `agent_step`/`message_completion` of one terminal go out through two fire-and-forget async calls, so their relative network completion order is inherently unstable; the differential pairs events by name and same-name occurrence and does not treat cross-type terminal interleaving as a difference. Business stage order within a same-name event (for example `plan_request started -> completed`) must still match.
- Different trigger boundaries: foreground/background, live/recovery, 3000/3001.
- A legacy fixed zero changed to non-zero by new V4 runtime fields, or new fields such as `compactReason` changing a legacy empty string.

Duration fields are not erased wholesale. Scheduling-dependent durations are compared by fixture window and invariants; fixed zeros, negative clamping, part/total relation, stall threshold and permission waiting must satisfy the legacy formula exactly. The controlled fixture leaves an explicit positive gap in the reasoning phase, but repeated two-version runs showed the legacy renderer's two `Date.now()` calls can still land in the same millisecond, so only `reasoning agent_step.duration_ms` may be normalized within the non-negative integer range. Zero/positive differences in `generation`, `tool_call` and other steps still fail.

### Differential artifacts

```text
packages/desktop/.e2e-artifacts/telemetry-parity/<run-id>/<case-id>/
├── legacy/capture.raw.json
├── legacy/arms-final.raw.jsonl
├── current/capture.raw.json
├── legacy.normalized.json
├── current.normalized.json
├── diff.json
└── legacy|current/{home,network,wdio}/
```

`capture.raw.json` stores target `/event/report`, final ARMS and capture stages; `diff.json` stores case/run, legacy/current commits, capture path, capture stages and structured differences, so no separate manifest is generated.

Fixed diff categories: `MISSING_EVENT`, `EXTRA_EVENT`, `MISSING_FIELD`, `EXTRA_FIELD`, `TYPE_MISMATCH`, `VALUE_MISMATCH`, `RELATION_MISMATCH`, `ORDER_MISMATCH`, `TIMING_INVARIANT_MISMATCH`.

Raw artifacts stay local and are never committed. Only privacy-checked, ID-aliased legacy normalized payloads may be promoted to goldens of this repo. If prompt body, tool input/output, URL path/query, token/header appear in a fact or golden, the test fails.

## Implementation and promotion order

1. **Vertical slice**: TDP02 establishes the two-repo runner, final capture points, normalizer and structured diff.
2. **Golden completeness**: full payload/fake-clock tests for TDP04-TDP08 and TDP10-TDP13.
3. **Lifecycle E2E**: pending specs for TDP01-TDP03, TDP09, TDP11, TDP14-TDP19.
4. **Legacy certification**: run `z-code-2` and current per case; resolve every non-allowlisted diff.
5. **Legacy golden**: after human review commit redacted normalized goldens; daily CI runs the current version only and does not depend on `~/workspace/z-code-2`.
6. **Formal promotion**: pending fixture check -> explicit replay -> default replay -> isolated Docker -> human review/promotion -> Docker preset admission.
7. **Final verification**: focused tests, desktop E2E typecheck, `pnpm typecheck`, `pnpm lint`, then one production desktop runtime smoke, recording external conditions that remain uncovered.

### Execution result (2026-07-18)

- `20260718-tdp-all-final/TDP01..TDP19`: all 19 cases captured the final `/event/report` HTTP body at Electron `net.fetch` and the final ARMS payload before main's `armsRum.sendCustom`; all 19 `diff.json` are `equal=true`, `differences=[]`.
- Covered: direct/queued/terminal, thought/text/tool/permission, foreground/background, 3000/3001ms stall, three compact terminals, five model-request states, visible/suppressed errors, feedback, quota, official-build safety check, live-only/recovery, workspace/remote/Web no-op. TDP16/TDP17/TDP19 additionally run positive production quota / safety-check / Web state assertions; "both sides empty" must not pass as success.
- `20260718-tdp02-final/TDP02` and `20260718-core-i/TDP-CORE` remain the representative real-provider/replay runs (two consecutive turns, tool success, compact success, reasoning, 3001ms stall, interrupt) with zero diff. Atomic cases use controlled fact sequences to reliably create failures, permission waits and exact millisecond boundaries that real providers cannot.
- The target inventory matches the legacy production call-site audit: `/event/report` has only `send_btn`, `message_completion`, `agent_step`, `context_compaction`, `assistant_message_feedback`; ARMS has only five `perf_ui_*`, `plan_request`, `plan_ttft`, `chat_error_banner`. Purchase-module internal events are out of scope.
- 14 focused regression files, 152 tests pass; fixture check, full typecheck and full lint pass.

Two-round captures also showed that legacy `agent_step`/`message_completion` network completion order swaps between adjacent turns, so the runner compares only stable business order. The differential specs stay in `manual-review/pending` and count only as executed automation evidence, not a formal gate. Raw artifacts stay local.

## Definition of done

- Every TDP01-TDP19 has a legacy/current dual-Electron final-exit capture and an independent diff; cases that expect zero reports also have a positive assertion that the production state actually arrived.
- Legacy target events in `/event/report` and ARMS have no missing, duplicate, field/type/relation error in current.
- Negative boundaries (Web/mobile, initial/hydration/recovery, background UI ARMS) are proven by automation.
- Quota regression stops at the conversation Upgrade entry handoff and does not disguise the purchase flow as part of this restore.
- Case catalog, coverage matrix, fixture manifest and actual spec status are in sync; pending does not count toward the formal gate.
- Raw differential artifacts are not committed; redacted goldens pass the privacy test.
