# Conversation Turn Hook Summary

> Status: product semantics confirmed 2026-08-19; this is the fact spec for the Hook icon at the bottom of a conversation, the details overlay and the multi-client projection.

## Goal

When a product turn actually ran user, workspace or plugin Hooks, the assistant action bar at the very bottom of that turn gets an `Anchor` icon:

- Hover or keyboard focus shows only the localized short tooltip "钩子" / "Hooks".
- Click or keyboard activation opens a details Popover anchored to the icon; mobile Web opens it by tap.
- The details answer only "which Hooks actually ran in this turn in order, where each came from, and whether anything went wrong".
- When no Hook actually executed, the icon is not shown and no empty assistant work container or empty virtual row is left.

This feature does not change Hook configuration, Trust, matcher, execution order, output consumption or task success/failure semantics.

## Product boundary

### Scope of counting

- The icon and details aggregate by the authoritative `turnId`, not for the whole session.
- `UserPromptSubmit`, tool Hooks, `Stop` and others belong to the real product turn that triggered them.
- On a normal first start `SessionStart` belongs to the first turn via the `turnId` the runtime already carries.
- A "real user-intent turn" is a `user-visible` TurnStarted. A maintenance turn (a controlOnly command turn such as manual `/compact`) is not eligible to carry the SessionStart summary: neither pending placement nor cold-merge attribution may take it as a closing target.
- model-only is not the same as a maintenance turn (revised in the 2026-08-28 review): background_task notification turns, subagent_message turns and goal continuation turns are also `inputVisibility="model-only"`, but they are agent turns that really run tools; their PreToolUse/PostToolUse/Stop must attach directly to the original turn by `event.turnId`, keeping live and cold-merge attribution consistent. The maintenance-turn exclusion applies only to pending placement of SessionStart and must not intercept all Hooks indiscriminately.
- When a session is only opened with no later real turn, no visible timeline content is created for a resume Hook alone.

Bug background (2026-08-28, HK17): in the runtime `runSessionStartHooks` runs before `/compact` input parsing; when the first input is `/compact`, the SessionStart Hook really executes and the event carries the compact runtime turnId; projection-layer flush and cold-merge attribution looked only at "the next TurnStarted" without excluding the model-only maintenance turn, and the Hook summary was wrongly attached to the compact marker turn:

```text
User's first input "/compact"
  Runtime turn()
    ├─ runSessionStartHooks("startup")     ← Hook really executed (didExecute=true)
    ├─ parseCompactCommand(input) → compact
    └─ executeManualCompact()
         └─ TurnStarted{ inputVisibility="model-only" }   ← maintenance turn
            ├─ compact lifecycle marker
            └─ TurnComplete

Projection placement (live / cold share one constraint)
  SessionStart lifecycle → pending
  TurnStarted(compact, model-only)  ─X→ must not flush/attribute (the fix)
  TurnStarted(next real, visible)   ─→  flush to that real turn
  only /compact with no later input ─→  summary stays pending, no visible timeline content created
```

- Cold recovery must first build the runtime turn → hydration turn mapping from the persisted message `anchor.turnId`, then classify the Hook lifecycle; a completed turn's Hook must not be left in a runtime-turn orphan or pending set.
- When one runtime turn is split into several product turns by queue drain, the cold merge must advance the current hydration turn by `TurnSteerDrained/SessionInputPromoted.messageId` and freeze that invocation's attribution when the first Hook lifecycle arrives; the mapping must not be dropped because several durable messages share a runtime anchor.

### Definition of "actually executed"

- Only an execution that received `HookRunStarted` counts as "actually executed" in the details. Success, failure, timeout, cancellation and the Hook itself actively blocking after execution are all kept.
- A `HookRunBlocked` produced directly by admission before process execution is not displayed as "ran"; the existing Workspace Hook pending/review UI keeps explaining untrusted or policy-blocked cases.
- An internal Hook defaults to `clientVisible=false` and does not enter the user-visible summary.
- The icon shows only when at least one actually executed client-visible execution exists.

### Source

The source keeps three real semantics and does not disguise a plugin as User or Workspace:

| `sourceKind` | zh-CN display | en-US display |
| ------------ | ------------- | ------------- |
| `user`       | 用户          | User          |
| `project`    | 工作区        | Workspace     |
| `plugin`     | 插件          | Plugin        |

`internal` is not displayed.

### Visible states

| Runtime result           | UI state           |
| ------------------------ | ------------------ |
| started and not terminal | running (运行中)   |
| success                  | completed (已完成) |
| executed block           | blocked (已阻止)   |
| failed                   | failed (失败)      |
| timed_out                | timed out (已超时) |
| cancelled                | cancelled (已取消) |

A Hook failure does not auto-expand the Popover, does not raise a global Toast and does not mark the task as failed directly.

- If an actually executed `UserPromptSubmit` Hook blocks the current input, the redacted block reason is synced to `snapshot.control.lastError` and shown by the chat area's `ChatErrorBanner`; this is only an error prompt for the current input and does not change a successfully completed turn into `phase=error`, and the next `TurnStarted` clears the prompt. Hook blocks that have not yet executed at the admission stage, and tool-boundary blocks such as `PreToolUse`/`PermissionRequest`, are still shown only in the Hook details, to avoid misreporting a tool-level permission ruling as a chat-input error.

### Chat Error for a UserPromptSubmit block

```text
HookRunner
  -> HookRunStarted
  -> HookRunBlocked(blockReason, stderrPreview/errorMessage)
  -> ProductProjection
       ├─ HookInvocationRow.executions[].blockReason
       └─ control.lastError(fault.runtime.hookBlocked)
  -> ChatErrorBanner (above composer)
```

- `control.lastError` is written only when the same `hookRunId` has received `HookRunStarted` and the event is `UserPromptSubmit`; an admission-only blocked does not meet the "actually executed" condition.
- `lastError.message` starts with the stable error type `hooks_prompt_block`; when a redacted `stderrPreview` / `errorMessage` / `stdoutPreview` exists, the summary format is `hooks_prompt_block: <diagnostic>`, and without a diagnostic only the error type is shown. `recoverable=false`, no retry entry is shown. `lastError.detail` always keeps the generic `blockReason` and appends the full Hook error when a diagnostic exists; the "view details" button of the Chat Error opens that content, and the banner uses the Hooks icon on the left. `traceId` is kept for copying the error and feedback.
- `TurnComplete(resultType="success")` is still the terminal state of the turn after a Hook block; `phase` and task success semantics are unchanged; `TurnStarted` clears the old `lastError` so that an old turn's reason does not cover the next input.

## UI spec

### Action bar

```text
[copy] [like] [dislike] [Fork] [Anchor]
                           │ hover/focus -> Tooltip "钩子"
                           └ click/Enter/Space -> details Popover
```

- The icon reuses the `Anchor` of the Hooks settings entry, with the size following the existing message action icon (`size-3.5`).
- The desktop action bar keeps the existing whole-turn hover/focus display; the mobile remote action bar is always visible.
- "Not permanent" refers to the data gate and not a new hidden state: the Hook icon renders only when at least one client-visible execution of the turn has `didExecute=true`; when the turn ran no Hook, the entry is absent from the DOM entirely.
- The Hook action is a turn-local artifact located after text, previews, scheduled-task cards, the file summary and the browser turn-tail image, but before the consecutive `turnTailBoundary`.
- When assistant text exists, copy/feedback/fork/time still show; for a terminal turn with no text, interrupted or errored, a Hook action may also be shown alone if a Hook actually ran.
- At most one Hook entry per turn: the ordinary assistant action bar and the standalone Hook action bar must be mutually exclusive. The Highspeed source footer renders independently, and must neither let a turn with text show Hook twice nor hide the Hook entry of a textless terminal turn.
- The Hook action shares the same turn eligibility with copy/feedback/fork/retry: a `timelineOnly` maintenance turn (a pure compact/modelChange marker turn) must not render a Hook action or an empty action bar even if it carries a legacy `didExecute=true` Hook row; the exemption of the textless terminal turn (HK11) covers only real product turns.
- The Tooltip and the Popover cannot be visible at the same time; the Tooltip closes when the Popover opens.

### Details Popover

```text
┌─ Hooks ─────────────────────────┐
│ SessionStart         User   12ms │
│ SessionStart         User   18ms │
│ UserPromptSubmit     User    7ms │
│ PreToolUse      Workspace   24ms │
│ PreToolUse      Workspace  1.25s │
│ PostToolUseFailure Workspace 8ms failed │
└─────────────────────────────────┘
```

- Uses `bg-popover + border-popover-border + rounded-xl + shadow-md`.
- Desktop uses a compact fixed width; on mobile the width does not exceed `calc(100vw - 2rem)`.
- The title area has 8px vertical padding, the outer list keeps only 2px vertical spacing, and each Hook has 6px vertical padding; 8px between event and source, raising the scan density of long lists without shrinking the font.
- The Popover shell's max height is constrained by both `20rem` and Radix `--radix-popover-content-available-height`; beyond it only the inner list scrolls, and none of the shell's `top/right/bottom/left` may cross the viewport collision padding.
- Invocations enter the Renderer derivation in CLI row order; inside one invocation the `didExecute=true` executions are listed one by one in `hookIndex` order. Identical Hooks are neither aggregated nor de-duplicated; repetition is a direct expression of the authoritative execution order.
- Each row shows only the Hook event and source; the product wording for `project` is uniformly "工作区" / "Workspace".
- `displayName`, runtime executable, script file name, tool name or execution count are not shown. Even without an explicit Hook name, no user-visible name may be derived from the command or file name.
- A terminal execution shows a de-emphasized duration after the source: under 1 second an integer `Nms`, 1 second and above in seconds, with two decimals under 10 seconds and one decimal otherwise. A running execution shows no unfinished duration.
- A successful terminal state shows no redundant green icon or "completed"; only running, failed, timed out, cancelled and executed block show status text/semantic icon, and anomalies cannot be expressed by color alone. The anomaly state is placed after the duration.
- An executed block shows the redacted block reason directly to the right of the status icon; when the reason is missing it shows the generic `Hook blocked execution`; the Hooks icon in the action bar synchronously shows the first block reason on its right, so users need not hover or open a tooltip to know why it was blocked.
- The title shows only "钩子" / "Hooks"; the "N hooks executed" subtitle is no longer shown.
- The first version shows no runtime, script file name, tool name, count, full command, absolute path, stdin, tool input, environment variables, stdout/stderr or stack; the online client-safe row must still not transmit the full command or other sensitive raw fields.

The Popover is read-only detail and offers no rerun, Trust, config edit or jump to settings.

## State and sync chain

```text
HookRunner
  -> HookRunStarted / HookRunCompleted / HookRunFailed / HookRunBlocked
  -> CLI session event log (the only persisted source of truth)
  -> ProductProjection
       - hookInvocationId aggregates invocation
       - hookRunId aggregates execution
       - authoritative turnId / pending resume SessionStart placement
       - generate client-safe HookInvocationRow
       - UserPromptSubmit executed block synchronously generates transient control.lastError
  -> connection-owned delivery
       desktop-continuous     -> direct continuous delta/snapshot
       web-remote-replayable  -> replayable delta/gap/snapshot
  -> Renderer ConversationProjectionStore (no Hook-specific store)
  -> ConversationTurnRenderUnit.hookInvocations
  -> terminal turn action + details Popover
```

The identity conversion in cold recovery is fixed as:

```text
durable message anchor.turnId (runtime)
              │ transcript message identity
              ▼
       hydrate-turn-* event turn
              │ ProductProjection TurnStarted mapping
              ▼
       stable product turn (messageId)
              ▲
              │ Hook lifecycle is first rewritten to the hydrate turn in the cold merge
runtime Hook turnId
```

This conversion applies only to cold/replayable materialization; desktop continuous keeps the original live event order and runtime → product mapping and does not stitch cold events.

The shared safe summary contains only display identity, source, event/tool, state, redacted block reason and authoritative duration. Desktop and mobile have the same business facts; the two differ only in the delivery and recovery of continuous/replayable. relay, desktop main and Host owner/lease add no Hook session state and build no second cache or queue.

## Protocol projection

`HookInvocationRow` is a turn-local read-only product row. An execution contains at least:

```ts
interface HookExecutionProjection {
  hookRunId: string;
  hookIndex: number;
  didExecute: boolean;
  state: "running" | "completed" | "failed";
  outcome?: "success" | "blocked" | "failed" | "cancelled" | "timed_out";
  blockReason?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  displayName: string;
  sourceKind: "user" | "plugin" | "project";
  pluginName?: string;
  toolName?: string;
}
```

Constraints:

- `didExecute=true` can only be derived from `HookRunStarted` having been observed for the same `hookRunId`.
- A terminal-only `HookRunCompleted/HookRunFailed` can still be used to close out the row safely but must not infer `didExecute=true`, nor let that execution trigger the Anchor or enter the details.
- An admission-only blocked execution may be used to close an invocation completely, but the Renderer does not count it in the details and icon.
- The row carries no `HookExecutionDescriptor.commandDisplay/sourcePath` or raw error/output fields.
- An async terminal upsert may arrive after the turn completes but must not push an already terminal turn back to running.
- After a CLI restart a started-only execution is closed out as `failed/cancelled`; an ordinary task switch must not be misjudged as cancellation.
- When edit/retry/rewind deletes a branch, the Hook row of the same turn is deleted together with the authoritative `row.removed`.

## Multi-client boundary

```text
one CLI projection
      ├─ connection A / desktop-continuous
      └─ connection B / web-remote-replayable

B gap/resync/snapshot  -X->  A continuous cursor
A direct live stream   -X->  B bypassing replayable recovery
```

- Mobile keeps attaching to the shared Host/runtime of the desktop window and starts no separate Agent, Host or remote session.
- The Hook summary carries no workspace path, so no `workspaceIdentity` key is added; subscription and task/session isolation keep reusing the existing attachment's `workspaceIdentity?.trim() || workspacePath` and `remoteSessionId`.
- A replayable snapshot and rows/range must restore the same Hook summary; supporting only the live delta is not enough.

## Cases and pruning

| Case | Setup                                                                                                                                                                   | Action                                                                                             | Assertion                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HK08 | A completed turn actually ran user/project/plugin Hooks                                                                                                                 | hover, then click the Anchor                                                                       | hover shows only "钩子"; click lists event, source and terminal duration one by one in authoritative order, repeated Hooks not merged; no runtime, script file name, tool name or count; located before the turn boundary |
| HK09 | One invocation contains an admission-only blocked, a terminal-only and an actually started execution                                                                    | turn completes                                                                                     | the details count only the actually started execution; with all admission/terminal-only the icon is not shown                                                                                                             |
| HK10 | A completed history Hook carries a runtime turnId; the same runtime split into several product turns by queue drain; or a resume `SessionStart` with no product mapping | cold reopen; or open history and then send the next real prompt                                    | the Hook is attributed by message boundary to the corresponding hydration/product footer, with no orphan runtime turn, `session-hooks:*` synthetic turn or empty container                                                |
| HK11 | An interrupted/error/no-assistant-text terminal turn actually ran a Hook                                                                                                | turn closes                                                                                        | the Hook action still shows; assistant-only copy/feedback/fork is not faked                                                                                                                                               |
| HK12 | desktop live and mobile replayable snapshot/gap                                                                                                                         | open the details of the same turn                                                                  | the safe summary terminal states agree; the payload contains no command/path/stdin/stdout/stderr/tool input                                                                                                               |
| HK13 | An async Hook reaches terminal after the turn completes                                                                                                                 | an upsert arrives while the Popover is open or closed                                              | the same execution updates in place; the turn does not become running again and component identity is not reset                                                                                                           |
| HK14 | A history branch with a Hook is truncated by edit/retry/rewind                                                                                                          | apply `row.removed`                                                                                | the Hook action and details disappear with the target turn, not appended to the end of history                                                                                                                            |
| HK15 | The Hook footer with 15 actual executions near the sticky composer / viewport bottom                                                                                    | scroll the real Anchor into view and click via WebDriver, then scroll the inner list to the bottom | the Popover lies fully inside the available viewport; `ul.scrollHeight > clientHeight` and itself `overflow-y:auto`; after scrolling the last DOM item is visible and matches the last item in authoritative order        |
| HK17 | The first input is `/compact`, the workspace configures a client-visible SessionStart Hook; a real prompt follows                                                       | observe the compact marker turn and the next real turn                                             | the compact maintenance turn renders no Hook Anchor; the SessionStart summary lands in the footer of the next real turn; with only `/compact` and no later input the summary stays pending with no orphan Hook row        |

Explicit pruning:

- No full Cartesian product with the seven Hook events; prompt, tool and stop/session represent the three placement classes.
- theme/locale are covered by shared components and i18n unit tests, without copying the runtime state-machine E2E.
- local/SSH/WSL/Docker share the desktop continuous projection; SSH is only a workspace-isolation representative, without copying four UI cases.
- mobile verifies only replayable recovery and click interaction, without copying the Desktop hover case.
- Trust state, matcher, process/command and sync/async execution effects remain covered by the Hooks runtime/Trust dedicated cases.

## Verification

- contracts/shared: strict schema rejects sensitive fields, and both continuous/replayable keep the safe summary.
- bootstrap: live/cold, resume SessionStart placement, admission-only blocked, async terminal, rewind, and a maintenance turn (model-only TurnStarted) not carrying the SessionStart summary (HK17).
- UI: turn render unit extraction, no empty work, Tooltip/Popover, source/state/i18n, textless terminal turn, mobile width, and a timelineOnly maintenance turn not rendering a Hook action (HK17).
- E2E: reuse the formal Hooks lifecycle fixture, asserting the Anchor, the Tooltip, the click details and at least one Hook source.
- A visual E2E must first scroll the real Anchor into the viewport and then use a WebDriver pointer/click; opening an invisible trigger with `HTMLElement.click()` and treating the screenshot as layout-passing evidence is forbidden. After opening, assert that the Popover rect lies inside the viewport, the list definitely overflows and the scroll container is the inner `ul`; after scrolling to the bottom verify the last item is visible.
- Mechanical gates: `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck`, `pnpm lint`.

## Delivered state and known gaps

Implemented (2026-08-19): client-safe Hook row, startup/resume SessionStart product-turn placement, cold merge, continuous/replayable delivery. The Renderer carries the summary independently in `ConversationTurnRenderUnit.hookInvocations`, outside assistant work, the "worked" fold and the ChatLoading decision. Focused tests exist for Tooltip and click Popover, zh/en source/state, textless terminal turn, pure admission blocked and async terminal open-state retention. The formal Desktop Hooks lifecycle replay passed 4/4.

Review fixes and rules derived from them (summarized in the sections above):

- HK17 (2026-08-28): ProductProjection tracks `currentTurnStartedModelOnly`; flush and direct-attach both use the user-visible real turn as the only closing target; cold `hookInvocationTurnIds` skips model-only TurnStarted; UI `hasHookActions` shares the `!timelineOnly` eligibility with copy/feedback/fork. Regression: bootstrap `product-projection.test.ts` HK17x2, `cold-event-merge.test.ts` HK17x1, UI `v4ConversationTurnGroup.test.ts` HK17x1; E2E `conversation-session-hooks-lifecycle.test.ts` adds the HK17 case.
- The first direct-attach gate intercepted the Hooks of all model-only turns, so tool Hooks (PreToolUse etc.) of the three model-only real agent turns (background_task / subagent_message / goal continuation) were swallowed by pending and wrongly flushed to the next user turn, diverging live and cold attribution. Narrowed: the maintenance-turn clause of the direct-attach gate applies only to `SessionStart`; tool Hooks attach to the original turn by `event.turnId`. Regression: `product-projection.test.ts` "HK17 keeps tool Hooks of a model-only real agent turn attached to that turn".
- SG-01: the two close-out paths for an abnormal terminal model-only turn (TurnError non-controlOnly path not clearing the side table, TurnComplete cancelled clearing it) behave equivalently: a pending SessionStart does not leak into the abnormal turn, a SessionStart arriving after the terminal state does not attach to the dead turn, and the next real user turn closes both startup and resume pending summaries together. Regression: `product-projection.test.ts` "HK17 keeps a pending SessionStart summary off an abnormally terminated model-only turn".
- 2026-08-24: terminal-only completed/failed no longer infer "actually executed"; the cold merge freezes Hook invocation attribution by persisted message boundary when one runtime turn is split into several product turns by queue drain. HK15 formal Electron isolated replay passed 1/1 (artifact `packages/desktop/.e2e-artifacts/desktop-e2e-20260823-165442-024`), proving the inner `ul` really overflows with `overflow-y:auto` and the authoritative last item is visible after scrolling; the adjacent HK-EF-01 re-verified 1/1 (artifact `desktop-e2e-20260823-170301-439`).
- Cold recovery review: the old merge compared the runtime turnId directly with `hydrate-turn-*`, forming orphan rows for completed Hooks and leaving SessionStart pending. Now the runtime → hydration mapping through the persisted message anchor happens before entering ProductProjection.
- Popover density: `w-80`, font size and information hierarchy unchanged; title/list/row vertical padding tightened to 8px/2px/6px. Per-row duration was added after the source (empty while running; compact `Nms` / `N.NNs` in a terminal state).
- Boundary-corrected version of 2026-08-20: details are back to the minimal set of event + source + anomaly state; repeated executions are listed one by one in order, no longer aggregated into `xN`, and no runtime, script file name, tool name or command-derived name is shown. The earlier dark-theme screenshot was produced by the test clicking an off-viewport DOM trigger directly and with the Popover height computed only by `100dvh`; it does not count as visual acceptance. Real visible-click evidence is HK15. In a 1200x800 viewport the Popover bounds were `left=450.0, right=769.7, top=55.9, bottom=375.6`.

Known defensive gaps registered but not fixed (not introduced by this change, not blocking for now): UI `shouldKeepRenderUnit` still keeps the whole section for a hook-only empty unit (a pt-14 ghost blank), hard to trigger in normal projection after the fix; a pending SessionStart is silently cleared by `onSessionResumed` at runtime resume (epoch switch semantics, and the new epoch produces a new resume SessionStart).
