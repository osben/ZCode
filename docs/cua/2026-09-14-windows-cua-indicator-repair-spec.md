# Windows CUA operation indicator repair spec

## Status

Accepted (2026-09-14)

## Goal

The Windows top banner ("ZCode 正在操作电脑" / "ZCode is controlling your computer") is visible while
the model uses Computer Use and can be dismissed in every case.

The indicator stays on the desktop main side (`windowsCuaOperationIndicator.ts`, existing since
2026-08-04). Only the detection chain broken by the SDK refactor is repaired.

Unchanged: model-visible tool surface, SDK shape, broker protocol, Helper lifecycle and process model,
macOS PiP behavior. The zcode-cua producer has zero changes, so no pin bump.

## Why detection fails today

`bootstrap/src/zcode-protocol/computer-use-operation-event.ts` extracted SDK call names from
`mcp__node_repl__js` `input.code` with a regex and compared them to the action vocabulary (the
tracker's `CUA_SDK_ACTIONS`). After the node_repl refactor no real call shape matches:

| Real model code (SKILL.md)                              | Regex result                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `agent.computerUse.getApp("Notes")`                     | `getApp` (not in the action set; facade methods are camelCase) |
| `app.click(42)` / `app.typeText(…)` / `app.pressKey(…)` | no match (variable is `app`)                                   |
| `agent.computerUse.computer.left_click({…})`            | no match (`computer` is followed by `.`, not `(`)              |

The only matching shape, `agent.computerUse.left_click(…)`, exists in neither the SDK nor the docs; it
exists only in the fixtures of `bootstrap/tests/computer-use-operation-event.test.ts`, so that test was
a false green.

Granularity defect: one cell holds several actions but the agent sees a single tool call, so
`AUTO_HIDE_MS = 10_000` is not renewed inside one cell and the banner goes out mid-operation when a
cell runs longer than 10 seconds.

## Design: one boolean fact

Detection reduces to: **does this cell use Computer Use**, regardless of action.

```
bootstrap  mapComputerUseOperationEvent
  └─ tool-scheduled: code.includes("setupComputerUseRuntime") → { computerUse: true }
        │  sideband (existing channel, no new kind)
        ▼
services   cuaOperationTurnTracker
  └─ stores the fact at schedule time → tool-started redeems it → reporter
        │  existing host→main channel
        ▼
desktop    windowsCuaOperationIndicator (existing; only the fallback timeout changes)
```

### Why the anchor is `setupComputerUseRuntime`

It is the bootstrap statement the model must copy verbatim, enforced by architecture: every node_repl
cell is a fresh Worker and SDK bindings do not cross cells, so the model-facing docs require "The first
executable statement of every CUA cell must be this bootstrap, and the bootstrap and the actions must
be in the **same** cell" (`zcode-cua-plugin/docs/computer-use.md:25`,
`skills/computer-use/SKILL.md`). Every CUA cell contains it.

It also has regression protection: `zcode-cua-plugin/tests/skill-sync.node-test.mjs` pins the pattern
`setupComputerUseRuntime({ globals: globalThis })` in SKILL.md, so rewriting the bootstrap turns that
test red. The old regex anchored on the action surface, which evolves and was pinned by nobody.

Browser Use (`agent.browsers.*`) has no such bootstrap and never matches.

### Why the fact rides only on `tool-scheduled`

`ToolCallStartedPayload` has no `input` field (`contracts/src/events/session.events.ts:633`), so model
source is unavailable at start; "is CUA" can only be decided at schedule time.

The overlay must light only at `tool-started`: between schedule and start the call may wait on
permission approval, when nobody is operating the computer. The tracker stores the fact at schedule
time in `computerUseScheduledCalls` (key `turnKey\0toolCallId`); `tool-started` redeems and consumes
it.

If the scheduled event is missing (for example dropped for lacking `turnId`), the banner does not
activate. The failure direction is "not lit", never "wrongly lit".

## Hide paths

One show entry, six hide paths; any one ends the display:

| Trigger                                | Location                                      |
| -------------------------------------- | --------------------------------------------- |
| `turn-completed` / `turn-failed`       | tracker `clearTurn` → reporter `active:false` |
| `session-closed`                       | tracker `clearSession`                        |
| New turn replaces the old turn         | tracker `retireTurn` + `clearSession`         |
| Workspace closed / runtime unavailable | `clearWorkspaceKey` / `clearSource`           |
| App quit                               | `dispose()` destroys the window               |
| All of the above fail                  | `AUTO_HIDE_MS` fallback timer                 |

The fallback goes from `10_000` to `30_000`. The fact is now reported per cell and later cells in the
same turn refresh the timer, but a single cell can run long and 10 seconds would extinguish the overlay
mid-operation; 30 seconds still guarantees it hides without anyone closing it.

Reporter and boundary-callback exceptions are swallowed and logged as warn only (`report` /
`notifyBoundary`): the display side channel must never cut the main session event chain. An exception
on the show path leaves the overlay unlit; on the hide path the fallback timer still ends it.

### Dropped: immediate hide

The old implementation recognized the `stop_computer_control` action name and hid immediately when the
model stopped control. With a boolean fact the action name is unavailable, so that shortcut is gone: if
the model keeps working after stopping control, the overlay stays until the turn terminal state or the
30-second fallback. This is the price of removing the action vocabulary dependency; the bound is
finite.

## Deleted dead code

- The `nodeReplComputerUseAction` regex and its three fictional-shape fixtures.
- Tracker: `CUA_SDK_ACTIONS`, `NON_OPERATING_ACTIONS`, `OFFICIAL_CUA_TOOL_PREFIXES`, `STOP_ACTION`,
  `resolveOfficialCuaAction`, `scheduledToolNameByCall`, `scheduledOperationActionByCall`.
- Protocol: the `operationAction` field of `tool-scheduled` / `tool-started`.

The `mcp__computer-use__*` prefix branch is removed too: `zcode-cua-plugin` registers no MCP server
(`package.json`: execution is provided by the shared node_repl host), old configs are dropped at
bootstrap and may not be re-registered (`2026-08-24-cua-node-repl-sdk-migration-spec.md`,
`cua-dev-mcp-runtime-assets.md`), and the tracker is fed only from the live sideband
(`zcodeAgentService.ts:1910`), so read-only parsing of historical transcripts never reaches it.

**Consumers verified (2026-09-14):** `ZCodeComputerUseOperationEvent` and
`zcodeComputerUseOperationEventSchema` are referenced in only three places: `packages/shared`
(definition and tests), `packages/services/src/zcode-agent/{zcodeAgentService,cuaOperationTurnTracker}.ts`
and tests, and
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/computer-use-operation-event.ts`. UI, desktop
main, web and other packages do not reference them, so `operationAction` has no consumer outside this
chain.

`toolName` / `toolCallId` stay: the tracker needs `toolCallId` to pair schedule and start.

## Acceptance

1. Bootstrap unit tests: fixtures use the real bootstrap statement from SKILL.md; pure Browser Use, an
   ordinary cell without the bootstrap, and a non-node_repl tool carrying the same text do not match;
   `tool-started` never carries the fact.
2. Protocol unit tests: `computerUse` accepts only `true` (`false` and action names are rejected);
   `tool-started` carrying `computerUse` is rejected by the strict schema.
3. Tracker unit tests: schedule alone does not activate; a node_repl cell without `computerUse` does
   not activate; `tool-started` without a scheduled fact does not activate; multiple cells in one turn
   renew each time; the five clear paths (turn terminal state, `session-closed`, new turn replacing,
   `clearWorkspaceKey`, `clearAll`) each work; a throwing reporter does not break event handling.
4. Indicator unit test: fallback is 30 seconds and every active report restarts the timer.
5. Zero hits under repo `src` for `operationAction`, `CUA_SDK_ACTIONS`, `resolveOfficialCuaAction`; no
   test asserts action-name inference from model source.
6. Real Windows machine: a CUA cell with several actions lasting over 10 seconds keeps the banner lit
   throughout; Browser Use and ordinary node_repl cells show nothing; the banner hides after the turn
   ends; copy follows the app language switch.

## Rejected alternative: Helper-owned window

A Helper-owned window mirroring the macOS PiP structure (panel and trigger fact in the Helper process;
trigger at `dispatchRequest`, the single choke point of every broker method; turn scope reusing
`pip_session_event`; window as an Electron `BrowserWindow`) was implemented and rejected. Its fact
source is more reliable than the regex (it sits at the injection point), but the cost is out of
proportion:

- The Windows Helper runs with `ELECTRON_RUN_AS_NODE=1`, which has no window API. Removing that costs 3
  extra Chromium child processes per Helper.
- It needs a new `indicator_set_presentation` (copy must come from the host; the Helper has no i18n).
  The protocol surface goes from 43 to 44, which by convention requires bumping
  `CUA_BROKER_IPC_VERSION` from 2 to 3.
- It needs a new state machine and window inside the Helper, delivered across two repositories with a
  producer pin bump.
- The two implementations may not coexist; the existing desktop main indicator would have to be
  deleted after real-machine acceptance.

Fixing one detection point on the zcode side keeps the producer untouched. A real defect found during
the attempt was fixed separately: `windowsCuaDevHelperHost.ts` hard-coded `ELECTRON_RUN_AS_NODE: "1"`
**after** `...commandEnv`, so `commandEnv` could never override it. That was the root cause of the
indicator never appearing in real-machine tests at the time.

Measurements for a future restart (Windows 11 / Electron 41.0.3):

| Check                                                                  | Result                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Helper ready / broker RPC / `stop()` exit in full Electron mode        | integration test 2 passed, exit 0                                               |
| `BrowserWindow` + `setAlwaysOnTop(_, "screen-saver")` + `screen` API   | all available                                                                   |
| `helperReaper` `--socket <value>` match                                | exactly 1 process has that value in its command line; exact claiming unaffected |
| Chromium children (gpu/utility/renderer) after hard-killing the Helper | all 3 exit with the parent, zero orphans                                        |

Do not use the negation of `isReadOnlyBrokerMethod` as a trigger. That set serves **soft-timeout**
detection (any side effect counts as an action); its non-read-only side mixes lease arbitration, focus
anti-steal and `pip_session_event`, and the latter is sent on every `turn-started`, so negating it
would keep the banner lit permanently.

## Migration and history

- 2026-08-04 `2026-08-04-windows-cua-operation-indicator-design.md` established the indicator and copy;
  the implementation lives in desktop main.
- 2026-08-24 migration to node_repl + SDK; the sideband carries `operationAction` parsed from SDK call
  names, originally in the flat `computerUse.<action>()` shape.
- 2026-09-13 `e2d7a9f2e9` reshaped the SDK to `getApp()` + bound objects + the `computer.*` escape
  hatch, with camelCase facade action names. The regex and `CUA_SDK_ACTIONS` were not updated and the
  indicator broke; CI stayed green because the path had no typecheck coverage (the test directory is
  outside `packages/services/tsconfig.json` `include`) and the fixtures invented the call shape.
- 2026-09-14 an attempt to have the producer publish action-level facts and return them to the agent
  via MCP notification (zcode-cua `4439fc8a`, rolled back by `c0ad9f81`) would need a new cross-process
  channel, protocol kind and trust boundary; after re-checking the PiP structure the panel can live
  with the fact in the Helper, so that return path is unnecessary.
- 2026-09-14 the Helper-owned window was implemented then rejected (see above); zcode-cua changes were
  reset entirely.
