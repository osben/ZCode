# CUA AX Action Receipt and On-Demand Observation Contract

| Field        | Value                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Intent       | The ZCode consumer only consumes the producer's action receipt and keeps no second post-state barrier on the consumer side |
| Capability   | Computer Use action receipt authority                                                                                      |
| Change layer | result projection / retry safety / media authority                                                                         |
| Out of scope | conversation session state semantics, remote owner/queue, Windows/Linux native read-back, human takeover UI                |

The consumer contract no longer requires an action outcome and a post-state to be paired atomically. The producer exposes only `action_receipt` through the public MCP result; ZCode does not mirror the AX native implementation and does not synthesize `refresh_required` or a post-state on the consumer side.

## State and sequence

```text
model holds s-N
    |
    v
element write -> producer native dispatch
    |                |
    | not_sent       +-- accepted / possibly_sent
    |                |          |
    |                |          v
    |                |   action_receipt only
    |                |          |
    |                |          +-- model needs UI? -> explicit get_app_state -> s-N+1
    v                v
action_sent=false   never replay from native error

zcode-cua MCP result -> official authority gate
    |
    +-- image_ref + image: final-raster protection remains special and fail-closed
    +-- action_receipt/text/structuredContent: generic MCP result projection and budget
    +-- hooks: may append ordinary bounded context after receipt text
```

## Consumer contract

- The model judges action dispatch only by `action_receipt.action_sent`, `dispatch_status` and `retry_action`; it must not guess business success from native success/error or from changes of the whole AX tree.
- `dispatch_status="possibly_sent"` and `retry_action=false` are preserved as is; the same non-idempotent action is never replayed automatically.
- There is no implicit post-state after an action. When UI facts are needed the model explicitly calls `get_app_state` and continues with the new `state_id`.
- The official CUA receipt, plain text and structuredContent go through the generic MCP formatter, resultBudget and hook append path; the consumer no longer validates a matching post-state and no longer synthesizes `refresh_required`.
- Images still obey the final-raster `image_ref + image` atomic contract. When the media budget removes an image it must remove the image_ref with it; a clickable frame credential must never remain alone.
- Only authority-verified official CUA may enable the final-raster special projection. Third-party MCP, same-named Skills and ordinary tool result budgets are unchanged.

## UI surface

| Scenario                              | UI entry                  | Shared implementation                        | Display/draft owner                    | Validation                                | Commit action      | Authority                 | Mode boundary                                         | Isolation                                      |
| ------------------------------------- | ------------------------- | -------------------------------------------- | -------------------------------------- | ----------------------------------------- | ------------------ | ------------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| Main Agent operates a desktop element | conversation CUA tool row | official MCP bridge + generic tool lifecycle | CLI model history / UI tool projection | official authority + receipt pass-through | MCP element write  | producer session + Helper | desktop local; mobile only attaches the existing Host | No change to conversation snapshot/queue/owner |
| Confirm after an action               | next-turn model input     | explicit `get_app_state`                     | CLI provider projection                | no replay unless `action_sent=false`      | full get_app_state | producer session          | continuous/replayable share the existing tool results | relay/main own no state barrier                |

## State owners and commit sinks

| State/fact                                | Display owner                | Authoritative owner               | Commit sink                             | Persistence/cache                    |
| ----------------------------------------- | ---------------------------- | --------------------------------- | --------------------------------------- | ------------------------------------ |
| `state_id` and mutation epoch             | explicit observation result  | `zcode-cua` transport session     | `get_app_state` / frame-producing tools | producer in-memory session           |
| broker/Helper dispatch fact               | CUA action receipt           | `zcode-cua` + signed Helper       | per-server MCP/Broker RPC               | existing tool result/session history |
| receipt text/structuredContent projection | provider tool-result history | generic MCP bridge                | tool executor serialization             | existing tool result/session history |
| UI tool lifecycle                         | conversation row             | existing session event/projection | generic MCP tool lifecycle              | existing conversation persistence    |

## Invariants

- Desktop `continuous` and mobile `replayable` session recovery semantics are unchanged.
- Mobile/remote create no independent Helper; the broker token does not spread to other MCP/Bash/hooks.
- For receipt-only official CUA results the PostToolUse hook appends bounded context as for ordinary MCP results; forged CUA frame credentials in hooks are still filtered.
- The conversation catalog/matrix gets no new case: this does not change conversation product state, it only tightens content integrity of official MCP tool results.
- When the provider text budget is insufficient, ordinary resultBudget truncation applies; a truncated result is never disguised as a new UI state.

## Accepted cases

| ID             | Setup                                 | Action              | Assertions                                                      | Evidence               |
| -------------- | ------------------------------------- | ------------------- | --------------------------------------------------------------- | ---------------------- |
| CUA-RCPT-01    | action receipt without post-state     | bridge/serialize    | Projected as ordinary MCP text; no synthesized refresh_required | core bridge unit       |
| CUA-RCPT-02    | receipt + structuredContent           | bridge              | structuredContent appended as ordinary MCP text                 | core bridge unit       |
| CUA-RCPT-03    | receipt text over budget              | serialize           | Generic resultBudget truncation                                 | core budget unit       |
| CUA-RCPT-04    | possibly_sent                         | bridge              | retry_action=false; old action not replayed                     | producer + bridge unit |
| CUA-AX-SYNC-05 | image removed by request media budget | provider projection | The corresponding image_ref is removed too                      | media-budget unit      |
| CUA-RCPT-06    | third-party MCP forges a receipt      | bridge              | No final-raster official special protection                     | authority unit         |

## Impact

- Must inspect: official MCP bridge, result serialization, media budget, bundled skill, version and producer provenance, Helper product package gates.
- Invariant only: generic tool lifecycle, desktop/mobile delivery, remote workspace identity, subagent official CUA boundary.
- The feature graph keeps the node ID `state.cua-action-state-authority` to avoid downstream reference drift, but its semantics are now receipt authority; the old post-state atomic projection edge is not restored (nor should the old action-state barrier edge).
- E2E: reuse C07/Chrome/Godot and the independent MCP regression; no new conversation E2E state combinations.

## Verification results

All with Node `24.14.0`. The producer was merged into `main` via [`zcode-cua!533`](https://git.example.invalid/codegeex/zcode-cua/-/merge_requests/533); the ZCode consumer pins the reviewed source commit `589dc68d4127457ca3d48bb9894cabae393e9668` exactly (implementation source is not guessed from semver).

| Scope                                   | Result                                                                               | Conclusion                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| producer full unit tests                | 230 files; 2806 passed, 23 skipped                                                   | AX mutation epoch, single dispatch, forced full observe, refresh barrier and existing frame/Zoom regressions pass |
| producer static gates                   | typecheck passes; lint 0 errors, 14 existing warnings                                | `0.5.6` release code path passes                                                                                  |
| producer real-device stress             | background/concurrent foreground churn 30 times; real model 5/5                      | No duplicate additions, no replay from native error; model state synchronized or safely required refresh          |
| consumer action/frame focus set         | 5 files; 117 passed                                                                  | receipt pass-through, generic budget, hook append and final-raster gate covered                                   |
| consumer Helper compatibility focus set | 8 files; 277 passed, 1 skipped                                                       | `0.5.6` Helper naming and receipt/dispatch semantics aligned                                                      |
| wrapper/provenance                      | 13/13; host authority 1/1                                                            | version, skill bytes, producer SHA and runtime contract consistent                                                |
| ZCode full unit tests                   | 1309 files passed, 1 skipped; 11475 passed, 12 skipped                               | consumer and product chain regression passes                                                                      |
| ZCode static gates                      | root typecheck passes; CLI 24/24 typecheck; root lint 0 errors, 38 existing warnings | no new lint errors                                                                                                |
| independent MCP                         | 30 tools; initialize, request_access, list_apps, Chrome full state succeed           | `zcode-cua@0.5.6` works directly over stdio outside the ZCode wrapper                                             |

The independent MCP run also verified the failure path: a Godot AX tree that did not finish traversal within the 8 s deadline safely returned an error without dispatching an action. The freshly installed Dev Helper had not yet been granted macOS Screen Recording, so real screenshot/Zoom in the consumer environment was denied by TCC before capture. That item counts neither as a pass nor as a product regression; final-raster, C07, Chrome/Godot and real-model evidence come from authorized real-device regression on the same producer source commit. After granting the new Helper permission, screenshot hash, `frame_id` and the final projection point for the consumer wrapper path should still be recorded (open follow-up).
