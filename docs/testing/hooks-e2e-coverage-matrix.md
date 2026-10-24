# Hooks E2E Coverage Matrix

## Feature Summary

| Field                 | Value                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Change                | Make the existing 7 Hooks events a configurable, executable, observable and regression-tested full lifecycle |
| User-visible surfaces | Settings > Hooks; conversation runtime; plugin hooks as a read-only source                               |
| Existing docs         | `docs/hooks-runtime-contract.md`, `docs/hooks-implementation-analysis.md`, `docs/plugin-hooks-compat.md` |
| Existing owners       | Agent HookRunner/configured runner; HooksService; HooksSection; plugin protocol                          |
| Out of scope          | New events; prompt/agent/http; `if`, `once`, `asyncRewake`; implicit legacy execution                    |

## Clarification Log

| Round | Question                                            | User answer                                                                                          | Boundary fixed                                          | Follow-up needed |
| ----- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------- |
| 1     | Extend this phase to all hook event types?          | "Only the 7 existing hooks are supported for now"                                                    | Cover only the 7 existing events                        | no               |
| 1     | Verify per event and add an overall E2E lifecycle?  | "Make sure all 7 hooks work, test them one by one, and add one e2e lifecycle case for hooks overall" | 7 focused contract cases + 1 window-level combined case | no               |
| 0     | How to handle the settings page and sources?        | Implement the confirmed plan                                                                         | `.zcode` editable, plugin read-only, legacy explicit import | no           |

## Domain Scope

| Domain                   | Include?            | Reason                                                               | Primary sources                                               |
| ------------------------ | ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| Agent runtime/config     | yes                 | Decides whether a Hook really executes and affects turn/tool         | `apps/zcode-cli/packages/{contracts,core,adapters,bootstrap}` |
| Permission/tool          | yes                 | The 4 tool events span validation, permission, success/failure       | `apps/zcode-cli/packages/core/src/tool/executor`              |
| Conversation/session     | yes                 | SessionStart, UserPromptSubmit, Stop sit in the turn lifecycle       | `apps/zcode-cli/packages/core/src/runtime`                    |
| Settings UI/source       | yes                 | Users configure `.zcode` and view plugin hooks                       | `packages/{services,ui}`                                      |
| Mobile remote/replayable | representative only | Hooks run in the shared Agent runtime; stream/snapshot/queue semantics unchanged | architecture invariant                                |

## State Owners

| State / fact                | Authority                                     | Mirrors / caches       | Evidence                                |
| --------------------------- | --------------------------------------------- | ---------------------- | --------------------------------------- |
| Hook config of the session  | Agent runtime snapshot                        | Settings UI file view  | runtime Hook events, Hook trace file    |
| `.zcode` Hook config        | user config file; project is shown/edited only | hooksStore            | file round-trip, service/runtime tests  |
| plugin Hook effective state | Agent plugin resolver                         | pluginManagementStore  | `plugins/list` payload, runtime trace   |
| Hook execution result       | HookRunner + event-specific consumer          | session event projection | tool result/model request/trace file  |

## Dimensions And Pruning

| Dimension      | Values                     | Decision                                                            | Reason                                    |
| -------------- | -------------------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| Event          | 7 existing events          | accepted all                                                        | User explicitly asked for each to work    |
| Hook source    | user/project/plugin/legacy | user+plugin runtime; project/legacy do not execute                  | Prevent silent arbitrary workspace commands |
| Hook type      | process/command            | accepted                                                            | Types the runtime already has             |
| Execution mode | process/command sync/async | E2E exercises real argv, shell and fire-and-forget paths separately | Executor capability needs window-level evidence |
| Client         | desktop/mobile Web         | E2E represents desktop-continuous; shared UI gets responsive/type tests | Mobile replayable business state unchanged |
| Platform       | macOS/Linux/Windows        | argv/shell by ExecutionPort unit tests; macOS and Linux Docker run E2E | Still cannot prove Windows             |
| Provider       | case-local DeepSeek replay | accepted representative                                             | Hook semantics are provider independent   |

Pruning:

- Do not cross 10 events with all tool names, modes, providers, themes and locales.
- E2E uses one Node recorder: `process` covers the 7 events; `command` sync/async represent the shell and fire-and-forget paths; no 7 events x 3 execution modes repeated combination.
- `PreToolUse` and `PermissionRequest` use a successful tool that needs approval; `PostToolUseFailure` uses a deterministically failing tool.
- Plugin display and legacy import are proven by settings/service focused tests; the overall lifecycle E2E focuses on the runtime loop.
- Mobile Web reuses the same HooksSection and Agent runtime; no separate runtime and no change to the `desktop-continuous` / `web-remote-replayable` boundary.

## Accepted Cases

| Case ID  | Setup                                                                                                          | Action                         | Assertions                                                                                                     | Evidence                                                                          | Status  |
| -------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------- |
| HK-01    | SessionStart process hook                                                                                      | Create a new session and send first message | Hook runs once; source/stdin/context correct                                                      | `hooks-event-contract.test.ts`, `runtime-hooks.test.ts`                           | covered |
| HK-02    | UserPromptSubmit process hook                                                                                  | Submit a prompt                | Prompt field correct; block/context take effect                                                                | `hooks-event-contract.test.ts`, `runtime-hooks.test.ts`                           | covered |
| HK-03    | PreToolUse process hook                                                                                        | Model calls a tool             | matcher, updatedInput/deny/context take effect; an early deny return still keeps the context                   | `hooks-event-contract.test.ts`, `tool-executor-trace.test.ts`                     | covered |
| HK-04    | PermissionRequest process hook                                                                                 | ask-permission tool            | hook allow/deny/modify replaces the broker                                                                     | `hooks-event-contract.test.ts`, `tool-executor-trace.test.ts`                     | covered |
| HK-05    | PostToolUse process hook                                                                                       | Tool succeeds                  | `tool_response` is the full output; context enters the next request                                            | `hooks-event-contract.test.ts`, `tool-executor-trace.test.ts`                     | covered |
| HK-06    | PostToolUseFailure process hook                                                                                | Tool throws                    | string error/is_interrupt; recovery context takes effect                                                       | `hooks-event-contract.test.ts`                                                    | covered |
| HK-07    | Stop process hook                                                                                              | Final assistant message about to end | transcript/last message correct; block continues the run at most 3 times in a row                        | `hooks-event-contract.test.ts`, `runtime-hooks.test.ts`                           | covered |
| HK-11    | PreCompact process hook                                                                                        | Trigger a real compaction (manual/auto) | trigger matcher, `custom_instructions` stdin, block skips this compaction and writes no failure       | `hooks-event-contract.test.ts`, `runtime-compact.test.ts`                         | covered |
| HK-12    | PostCompact process hook                                                                                       | After a successful compaction  | Fires only after a real successful compaction; not on skip/failure/mid-retry; output is diagnostic only        | `hooks-event-contract.test.ts`, `runtime-compact.test.ts`                         | covered |
| HK-13    | SessionEnd process hook                                                                                        | Session close                  | Exactly once at the start of close; 5 s shared budget timeout recorded as cancelled; hook failure does not block close | `hooks-event-contract.test.ts`, `runtime-hooks.test.ts`, `session-facade.test.ts` | covered |
| HK-LC-01 | Isolated user config with 7-event process hooks plus sync/async command; provider fixed modify, approval, success, failure chain | First message from the UI, wait for the final marker | 7 events, three execution modes, compatible stdin, Pre/Permission two-level input modification, allow, success/failure context, final idle | desktop UI + runtime file + isolated/default replay requests | covered |
| HK-EF-01 | PreToolUse in turn: deny, return invalid updatedInput, require PermissionRequest deny                          | Provider triggers three Writes in a row | Handlers never run; each early-failure result keeps its additionalContext; PermissionRequest fires only on the ask path | desktop runtime file + provider-visible tool results | covered |
| HK-ST-01 | Stop blocks every time; fixture provides only the initial response and three continuation responses            | Send the Stop cap marker       | Stop runs 4 times but continues only 3 times; the 4th context does not enter a new request; final response and idle correct | request count + trace + desktop UI | covered |
| HK-UP-01 | Same UserPromptSubmit has a sync process block and an async command block                                      | Send the prompt block marker   | Sync block ends before the model; async command starts/completes but its output does not change the current boundary | zero main request + trace + desktop UI | covered |

Extra regression boundaries:

- `command async:true` must return immediately, ignore the background decision, and terminate execution with `outcome: "cancelled"` when the caller cancels.
- `PermissionRequest` verifies deny and allow + `updatedInput`/`updatedPermissions` mapping separately.
- With a plugin explicitly disabled, runtime hooks are empty; plugin details stay in `plugins/list` so the settings page can show the disabled state read-only.

## Full-chain Hooks Suite

Formal spec: `packages/desktop/test/e2e/conversation-session/conversation-session-hooks-lifecycle.test.ts`

Case-local artifacts:

- Provider fixture: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-hooks-lifecycle.json`
- Manifest: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-hooks-lifecycle.json`
- File fixture: WDIO writes hooks into the isolated HOME user `~/.zcode/cli/config.json`; the spec writes the Node recorder/trace in the default workspace, then restores the user config and deletes workspace artifacts.
- Timing: `fast-text`. Hook execution and file assertions do not depend on SSE cadence.

Setup/action/assert:

1. Setup: all 7 events point to the same `process` recorder; SessionStart/UserPromptSubmit also get a sync and an async `command`. The recorder appends compatible stdin, executor, phase and readable transcript content to the trace.
2. Action: run four new sessions in order: full-chain, early-failure, Stop cap, prompt block.
3. Assert:
   - The Settings Hooks navigation is reachable and all 7 configured events render as config rows.
   - All 7 events appear in the process trace; SessionStart/UserPromptSubmit/Stop appear once each.
   - The Pre/Permission/Post success chain shares one tool use; the final input after two-level modification reaches the handler, and PostToolUse has the full `tool_response`.
   - The failure chain produces PostToolUseFailure with a string error, and the recovery context enters the next request.
   - The three pre-handler failure exits (Pre deny, invalid updatedInput, Permission deny) all keep their context.
   - Stop continues at most three times in a row; the 4th still runs the Hook but does not issue a 5th provider request.
   - The sync command really executes through the shell; the async command's output after completion does not change the already-continued event.
   - Each case's final UI returns to idle; model-needing cases show the final marker.

## Lifecycle Decision

- `manual-review/pending`: not used. The 10 events and their effects were explicitly confirmed by the user, so a formal deterministic replay case is written directly.
- `e2e:promote`: not used; the case is not a live probe awaiting manual judgment.
- `e2e:fixture:check`: must run.
- Isolated case-local replay: must run, proving independence from the legacy shared provider fixture.
- Default replay: must run.
- Docker: first a single-spec replay-isolated proof; only after it passes may `e2e:docker:admit` add it to the conversation preset.
- Closing gates: `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck`, `pnpm lint`.

## Verification Record

2026-07-13 full-chain suite:

- `e2e:fixture:check`: passed, 15 case-local fixtures.
- Isolated case-local replay: 4/4 passing. Default replay: 4/4 passing. Docker single-spec replay-isolated: 4/4 passing in a Linux/amd64 network-isolated container.
- Focused core: 3 files / 64 tests covering the 7-event contract, runtime Stop cap, tool execution trace, Permission/updatedInput/early-failure context.
- Settings/service: 2 files / 10 tests covering save, enable/disable, workspace identity, compatible import, plugin grouped display, and command async/shell round-trip.
- Static gates: `typecheck:e2e`, root `pnpm typecheck`, `pnpm lint` passed; lint 0 errors.

Known harness issue: WDIO runs of this suite log a ContextId-destroyed warning in Electron teardown after the test completes; exit code stays 0 and all Hook lifecycle assertions finished, so it is recorded as an E2E harness cleanup issue, not a Hook failure.

Full history: `git show b8876e8b:docs/testing/hooks-e2e-coverage-matrix.md`
