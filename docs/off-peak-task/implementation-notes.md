# Off-Peak Task Implementation Notes

> Maintainer implementation map. Product rules and decisions live in `spec.md` / `decisions.md` /
> `tech-design.md` (source of truth); this file only records where the code lives and how it is wired.
> Paradigm: a one-shot background task under Automations (D28).

## End-to-end flow

```
create form (OffPeakEditView) ──RPC──▶ IOffPeakTaskService.createTask
                                      │ take number POST /ticket (persist only on success)
                                      ▼
                            off_peak_tasks (sqlite, OffPeakTaskRepo)
                                      │ history_deleted_at only controls History visibility
                                      ▲                    │
   offPeakTaskSync polls /ticket/status, writes back schedulable/position   │ scheduler tick claims schedulable=1
                                      │                    ▼
                                      │        offpeak-dispatch-request ──▶ main ──▶ host OffPeakRun
                                      │                                              │ createTask/resume + sendPrompt
                                      │                                              │  (idle Selection + modelExecution, D33/M4)
                                      │                                              ▼
                                      │                              agent loop ──▶ idle plan provider
                                      │                                              │  POST /off-peak/anthropic/v1/messages
                                      │                                              ▼
                                      │                                   gateway (real / in-process mock)
                                      │   400/3102 ticket expired ◀──────────────────┘
                                      │        │ host recognizes marker → handleTicketExpiredDuringRun
                                      └────────┘   re-take with same task_id → resume same session
                      terminal → markTerminal → settle outbox → system notification
```

## Key files

| Layer          | File                                                                                                  | Responsibility                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types/protocol | `packages/shared/src/off-peak-types.ts`                                                               | seven-state domain types, error marker constants, `OFF_PEAK_PROVIDER_ID`                                                                                                                    |
|                | `packages/shared/src/channels.ts` + `validation.ts`                                                   | `OffPeakRun`/`OffPeakRunResult`/`OffPeakSchedulerWakeRequest` message pairs; V4 `sendText.modelExecution` (D33/M4)                                                                          |
| Storage        | `packages/services/src/session/offPeakTaskRepo.ts`                                                    | `off_peak_tasks` DDL + state-machine guards; `history_deleted_at` compatibility migration and local History hiding                                                                          |
| Services       | `offPeakServerClient.ts`                                                                              | availability/take-number/batch status/settle APIs; each request resolves the selected credential snapshot once and injects the Team org/project as a pair (messages do not go through here) |
|                | `offPeakMockGateway.ts`                                                                               | in-process mock gateway (`ZCODE_OFFPEAK_MOCK=1`); `resolveUpstream` returning null falls back to a fixed response                                                                           |
|                | `offPeakTaskService.ts`                                                                               | orchestration: create/take number, cancel, Pause-Continue, delete, edit, Delete history, offPeakTaskSync polling promotion, settle, 3102 continuation                                       |
|                | `offPeakRuntimeModel.ts`                                                                              | selected Coding Plan classification and credential snapshot, single Request Auth construction, origin/mock upstream resolution                                                              |
|                | `offPeakTask.ts`                                                                                      | `IOffPeakTaskService` descriptor (renderer RPC surface; exposes only redacted Coding Plan support to the UI)                                                                                |
| Scheduling     | `packages/desktop/src/scheduler/index.ts`                                                             | offPeak tick: claim schedulable and dispatch, start recoverInterrupted, report active count                                                                                                 |
|                | `packages/desktop/src/main/desktopCronScheduler.ts` + `index.ts`                                      | dispatch routing, result forwarding, keep-awake powerSaveBlocker                                                                                                                            |
| Host           | `packages/desktop/src/host/index.ts`                                                                  | OffPeakRun handling: createTask/resume, idle Selection/`modelExecution` injection, terminal write-back, 3102 continuation                                                                   |
| Adapter        | `apps/zcode-cli/packages/adapters/src/model/offpeak-retry.ts`                                         | 429/3105 queue exempts the budget with unlimited probing + 400/3102 continuation marker (idle plan provider only)                                                                           |
|                | `apps/zcode-cli/.../commands/handlers/session-flow.ts` + `prompt-turn.ts`                             | execution-scoped Selection/Request Auth enter Core; Session Selection is not modified and the ordinary Queue is not used (D33/M4)                                                           |
| UI             | `packages/ui/src/settings/{AutomationsSection,OffPeakEditView,OffPeakTaskList,OffPeakHistoryTab}.tsx` | three tabs, local project creation, list cards, History, gray-release and subscription gating                                                                                               |
|                | `packages/ui/src/store/offPeakTaskStore.ts`                                                           | zustand store (list/gray release/CRUD/10s polling; selected-connection support; availability snapshot controls quota graying and re-query at due time)                                      |
|                | `packages/ui/src/hooks/useOffPeakTaskNotifications.ts`                                                | completion/failure system notifications; permission/elicitation is handled by the ordinary session notification chain                                                                       |

## In-conversation creation (D49, v2)

```
user session turn ──model tool_use OffPeakCreate/OffPeakList──▶ core/tool/handlers/off-peak.ts
      │  (offPeakTurn denies Create; automationTurn allows it = combined play D49-3)
      ▼
bootstrap/zcode-protocol/offpeak-port.ts (activeOffPeakTaskId rejects recursion; no title freeze / no binding check)
      │ requestClient offPeak/create|list
      ▼
services zcodeAgentService offPeak/* handler (default resolution: yolo / allowed_models last / highest level;
      │  model whitelist pre-check; workspace injected by closure) ──▶ OffPeakTaskService.createTask (same chain as the form)
      ▼
success output → ConversationTurnGroup turn-tail static card (moon + title + position snapshot + 「去到闲时任务」)
      → onOpenAutomationsMain(offPeakTaskId,"idle") → AutomationsSection offpeak- prefix routing
      → offpeak-edit view (queued/paused editable, running/terminal readOnly)
```

| Layer     | File                                                                                                                                                                                                                                           | Responsibility                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| contracts | `apps/zcode-cli/packages/contracts/src/tools/off-peak.ts` + `interfaces/off-peak.port.ts`                                                                                                                                                      | tool schema (title/prompt required, permissionMode/model/thoughtLevel optional) and the OffPeakPort discriminated union      |
| core      | `core/src/tool/handlers/off-peak.ts`, `runtime/methods/turn-loop-state.ts` (isOffPeakCreateRestrictedTurn + OFF_PEAK_MUTATION_TOOL_NAMES)                                                                                                      | final rejection boundary in the handler + three turn signals; registration gate `includeOffPeak = Boolean(deps.offPeakPort)` |
| bootstrap | `zcode-protocol/offpeak-port.ts`, `server-operations.ts` (port injected only when offPeakToolEnabled), `zcode-protocol-v4/commands/prompt-turn.ts` (activeOffPeakTaskId + denylist)                                                            | protocol bridge and turn identity; a missing flag injects no port = fail-closed                                              |
| services  | `zcodeAgentService.ts` (offPeak/create\|list handler, offPeakToolEnabled delivery + compat, default resolution), `automationToolPolicy.ts` (independent OFF_PEAK_MUTATION_TOOL_NAMES constant), `node.ts` (forward-reference holder injection) | host-side orchestration; **OffPeakCreate must never be mixed into any copy of AUTOMATION_MUTATION_TOOL_NAMES**               |
| host      | `packages/desktop/src/host/index.ts` dispatch with `toolDenylist: ["CronCreate","OffPeakCreate"]`                                                                                                                                              | primary symmetric placement of D45 + D49-2                                                                                   |
| UI        | `ui/src/ToolCallBlocks/renderers/offpeak-create.tsx`, `v4/ConversationTurnGroup.tsx` (resolveOffPeakTurnCards), `settings/AutomationsSection.tsx` (resolveOffPeakDetailNavigation)                                                             | static turn-tail card and the idle-tab edit navigation                                                                       |

## Billing boundary (D33, the easiest place to go wrong)

The idle plan uses a hidden Built-in Provider and the standard Model execution chain; the Session
Selection always stays the user's own:

- Before creating the session at first dispatch, the workspace default view is read with
  `workspace/readState(preferWorkspaceDefaults=true)`; the full `providerId/modelId` is snapshotted
  by `defaultModel` -> `lastUsed` -> `settings.model.current` and passed explicitly to `createTask`.
  Reading the active session's runtime model is forbidden, and so is falling back at the OffPeak
  layer to `available[0]` or the provider registry's alphabetically first item. The current model of
  an old catalog comes from the same bootstrap as ordinary `session/create`. The OffPeak form model
  is used only for idle plan turns.
- The dispatched `sendPrompt` carries the exact idle Model Selection and a minimal `modelExecution`;
  Registry/ModelFactory creates the Active Model of the current Loop, and Request Auth is bound only
  to this execution.
- Zero persistence: no Session Selection, Config, Registry View, CLI record, workspace catalog or
  ordinary Queue writes, and no modelChange notification.
- Result: after the run session reaches terminal state, chat and busy-insert prompts are created with
  the user's model by their own ordinary Submission and Session Selection after the current turn's
  terminal; there is no switch-back timing.
- Permission boundary (D44): confirmation goes only through the ordinary session and the Off-Peak
  task stays `running`; an approval/denial inside the current automatic turn still uses the same idle
  Active Model. There is no Off-Peak-specific Review state, duplicate notification or "continuing
  will use your own plan quota" prompt. The reserved `awaiting_approval` value of old databases is
  migrated to `running` at initialization.

Dispatch errors are split by recoverability: missing user model, missing idle plan model, missing
JWT/Coding Plan Key are `permanent` (the scheduler marks the task `failed` and stops backoff);
network and Agent lifecycle unknowns stay `transient`. Reason: deterministic configuration errors do
not heal by retrying, while the old logic kept consuming the ready ticket and made the UI show
"Waiting for idle compute" forever.

## Coding Plan navigation, support and credential boundary (D40/D41)

```text
settings selected family/mode/key
              |
              v
exact connection classifier ──> registry/Team runtime-key helper
              |
              v
OffPeakCredentialSnapshot { metadata, jwt, codingPlanApiKey }
       |                 |                         |
       v                 v                         v
UI redacted support    ticket 4 API headers     modelExecution.requestAuth
```

- Supported: ZAI personal Coding Plan, BigModel personal Coding Plan, BigModel Team project
  connection.
- Rejected: Start Plan, API Key mode, nothing selected, active OAuth provider differing from the
  selected family, disabled/stale connection, missing JWT, or the selection/login identity changing
  during resolution.
- A single ticket-client request resolves the snapshot once; availability/take/status/settle and the
  host automatic turn use the same resolver. A Team connection takes `${apiKey}.${secretKey}` through
  the provider registry's existing Team runtime-key projection; never assemble the secret manually or
  fall back to a personal key on failure.
- The UI reads no secrets. The New Task home template reads only id/enabled/systemDisabledReason
  from the existing provider snapshot to decide whether any Coding Plan is held; with a plan but no
  selected provider it lets the draft carry into the form. The Automations create entry and form
  submit still save and verify redacted support metadata, confirming the current family/mode/selected
  key match the metadata; they do not scan or auto-select other credentials because home navigation
  was relaxed.

## Local demo / integration

```bash
ZCODE_OFFPEAK_MOCK=1 mise run dev:desktop           # in-process mock gateway lights up the whole flow
# Tunable timing (use small values to demo 3h continuation):
ZCODE_OFFPEAK_MOCK_READY_DELAY_MS=3000 ZCODE_OFFPEAK_MOCK_ACTIVE_MS=30000 \
ZCODE_OFFPEAK_MOCK_QUEUE_429_COUNT=2 ...
```

Mock mode forces the gray release on (`resolveOffPeakClientConfig`); `resolveUpstream` proxies only
the currently selected Coding Plan and returns a fixed response when that connection is unavailable,
never scanning other cached providers. To integrate with the real server, drop `ZCODE_OFFPEAK_MOCK`
to use the zcode API origin.

UI acceptance uses the local workspaces already open in the current window as Project candidates.
Mobile `/remote` does not expose Automations; desktop remote workspaces do not expose Idle-time. Do
not add `remoteSessionId` to the task protocol to select remote projects; creation is explicitly
local-only.

## Server alignment pending (tech-design §7.8)

Document Retry-After for 429/3105; actual take-number quota values; queue 429 must not carry
`x-should-retry:false`; if gray release hits per account, client/configs needs Authorization;
`next_poll_after` unit (the client implements seconds).

## Tests

- Unit: `packages/services/test/offPeak*.test.ts` (repo/service/client+gateway/gray config),
  `apps/zcode-cli/packages/adapters/tests/offpeak-retry.test.ts`,
  `apps/zcode-cli/packages/bootstrap/tests/offpeak-turn-model-overlay.test.ts`.
- End-to-end integration: `packages/services/test/offPeakE2eIntegration.test.ts` (runs the full chain,
  covers OP02/04/07 service-layer mechanisms).
- WDIO GUI E2E (OP01-06): registered as planned in the coverage matrix, depends on the desktop build.
