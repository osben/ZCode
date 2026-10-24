# Conversation Session Tool Cross Product Matrix

Goal: fill in the conversation-session coverage of compact, fork and goal over "history that contains tool calls". The old basis proved only the existence of one read-only tool with `Read /tmp/zcode-e2e-readonly-tool.txt` and could not represent file edits, commands, network failure states, plan mode, user questions, session-local state and failed tool blocks.

## Coverage boundary

The strong cross product of tool names is bounded by `packages/shared/src/tool-identity.ts`, `apps/zcode-cli/packages/core/src/tool/handlers/index.ts` and the plan-mode tools. Default-active tools must cover the success state; conditionally registered or currently unregistered tools also enter the UI cross product but may close with a fast-failure state, so the business success rate of a tool is not mixed into the conversation UI spec. Tools not exposed on this chain are not in this matrix.

| Tool                 | Default state                    | E2E input strategy                                                                                  | Result shape                 | Cleanup requirement                                              |
| -------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `Read`               | active                           | Read a dedicated fixture file                                                                       | success                      | Delete the dedicated directory                                   |
| `Write`              | active                           | Create a dedicated file                                                                             | success                      | Delete the dedicated directory                                   |
| `Edit`               | active                           | Create a dedicated file with an empty `old_string`                                                  | success                      | Delete the dedicated directory                                   |
| `Bash`               | active                           | `printf` outputs a marker                                                                           | success                      | No file written                                                  |
| `Glob`               | active                           | Match fixture files in the dedicated directory                                                      | success                      | Delete the dedicated directory                                   |
| `Grep`               | search-branch conditional        | The direct branch searches the dedicated fixture; the embedded-search branch fails fast on a registry miss | success / failed tool result | Delete the dedicated directory                                   |
| `WebFetch`           | active                           | Use a legal but non-public loopback URL to trigger a controlled fast failure; the business success loop is covered by `WF/O10` | failed tool result           | No external write                                                |
| `TodoRead`           | active                           | Read the current session's todo                                                                     | success                      | session-local; after a goal assert history toolCalls with the renderer store |
| `TodoWrite`          | active                           | Write the current session's todo                                                                    | success                      | session-local                                                    |
| `GoalRead`           | currently unregistered           | Empty input; if registered in the future, reads the current session goal                            | failed tool result / success | session-local                                                    |
| `EnterPlanMode`      | active                           | Empty input enters plan mode                                                                        | success                      | Reset to `yolo` after follow-up actions and before the next case |
| `ExitPlanMode`       | active                           | Called outside plan mode to verify the fast-failure tool block                                      | failed tool result           | None                                                             |
| `AskUserQuestion`    | active                           | One question with two options, the test auto-selects the first                                      | success                      | session-local                                                    |
| `ReadSessionContext` | active                           | Read a non-existent session id                                                                      | success fallback             | session-local                                                    |
| `SendMessage`        | conditional                      | Point at a non-existent `agent_*`, or fail fast when unregistered                                   | failed tool result           | session-local                                                    |
| `Agent`              | conditional/default subagent     | Illegal `subagent_type`, to avoid really spawning a sub-agent                                       | failed tool result           | None                                                             |
| `Skill`              | active                           | Load a non-existent skill to verify the fast-failure tool block                                     | failed tool result           | None                                                             |
| `Workflow`           | currently unregistered           | Empty input; even if registered later it fails fast for missing script/name/resumeFromRunId         | failed tool result           | None                                                             |

Fast-failure states are also in this matrix because it verifies the stability of the conversation UI with tool blocks + later compact/fork/goal, not the business success rate of external network, sub-agents or the skill registry. Each tool's own success semantics belong to the matching tool/service tests.

## Terminal closure for unregistered tools

Whether a tool appears in the provider schema and in the execution-time registry are facts at two points in time. The model may still return a tool name that a capability branch has hidden, that became invalid after a configuration hot switch, or that it made up; a registry miss cannot only return a provider-visible error and must also close the conversation projection in sync.

```text
provider tool_use(id)
  -> projection tool row: inputStreaming
  -> executor registry lookup: missing
  -> ToolCallError(id)
  -> projection tool row: error
  -> TurnComplete(success)
  -> cold snapshot / replay profile: terminal
```

| Case ID | Representative state                                                                                                         | Key assertions                                                                                                                                              | Coverage layer                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| TLT-01  | `Grep` unregistered in the embedded-search branch                                                                            | A failure before the handler still publishes a `ToolCallError` with the same `toolCallId`                                                                    | core executor focused test                  |
| TLT-02  | Before terminal there are still `inputStreaming/pendingApproval/running` foreground tools, or the parent turn ends before a background subagent child tool | `TurnComplete` closes the missed foreground rows as error/cancelled; an explicit background child tool is not falsely closed and a late terminal may close the same row | bootstrap projection/profile test           |
| TLT-03  | A single turn exceeds 60 rows and the cold tail lacks `turnHeader`                                                           | The terminal `session.phase` overrides the row-level running fallback and shows no ChatLoading                                                              | UI focused test + desktop cold snapshot E2E |

Pruning: the desktop E2E represents all unregistered tools with 60 embedded-search `Grep` registry misses plus 1 certainly unregistered Grep sentinel, and uses 61 calls of the same kind to stably cross the 60-row tail window; `Workflow` stays out of the formal TX tool set. Mobile replayable only reuses TLT-02's profile convergence and does not duplicate GUI or relay reconnect permutations.

## Cross scenarios

| Scenario             | Initial action                                                                                    | Follow-up action                                   | Key assertions                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compact-after-tool` | Send a prompt with a tool marker, replay returns the specified tool_use, then returns `upstream-e2e-ok` | `/compact`                                         | The original tool block exists; compact marker `started` -> `completed`; the compact request contains the tool marker                                                                                                                                                               |
| `fork-after-tool`    | Same as above                                                                                     | fork the assistant message containing `upstream-e2e-ok` | The new task/session id differs; the derived session keeps the original user prompt, the assistant token and the matching tool block                                                                                                                                                |
| `goal-after-tool`    | Same as above                                                                                     | `/goal E2E_TOOL_CROSS_PRODUCT_GOAL_*`              | The target objective updates; the original tool history still exists; `/goal` is not leaked as an ordinary visible user message of an internal goal continuation; `EnterPlanMode` keeps the plan-state semantics and only the target update is asserted, with no provider continuation required; an empty `TodoRead` result may be kept only as renderer-store toolCalls |

## Guide x Tool Result Batch coverage

The consumption guard of a guide depends on "whether the complete tool result batch of one model step has been committed", not on a specific tool name. So each tool in the table above is not fully permuted with guide; the shared invariant is proven by three equivalence classes: a successful single tool, a successful parallel batch and a failed tool result.

```text
tool calls emitted: T1, T2, ... Tn
  -> commit result(T1)
  -> ...
  -> commit result(Tn), success or failure
  -> batch terminal
  -> drain at most one guide
  -> next provider request in the same product turn
```

| Case ID | Tool shape                       | Guide timing                                   | Key assertions                                                                                                                                                  | Status                                    |
| ------- | -------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| GTB-01  | single readonly `Read` success   | Admitted before the tool call                  | `ToolCallResult` precedes `TurnSteerDrained`; the next provider request is sent only after the drain                                                            | pending: GS/P06 controlled-stream         |
| GTB-02  | two parallel readonly tool calls | A guide exists while the two siblings execute  | One sibling completing does not drain; after all results are committed at most one is drained                                                                   | missing                                   |
| GTB-03  | deterministic failed tool result | A guide exists before or during tool execution | A failed result is still part of the batch terminal; the failure fact is committed first, then one is drained                                                   | missing                                   |
| GTB-04  | text-only model step, no tool    | A guide is already admitted                    | The text-only assistant commits first; then at most one guide is drained, appended with the user role, and the next provider request starts in the same active turn | core covered; desktop pending: GS/P06 |
| GTB-05  | two guides + two tool batches    | Both guides admitted before the matching batch terminal | At most one per batch, in admission FIFO; no batch may empty both                                                                                    | missing                                   |

Pruning: concrete tools such as `Write/Edit/Bash/WebFetch/AskUserQuestion/Agent` keep proving tool-block stability through the original compact/fork/goal cross product of this matrix; guide adds only the batch-ordering invariant. The user-waiting state of an interaction tool is not permuted separately until it forms a tool result and enters the same batch terminal. Desktop continuous proves the timing with controlled-stream E2E, and mobile replayable is represented by a cold/live projection equivalence test of the same CLI facts, without duplicating the tool business matrix.

## Replay constraints

`provider-conversation-tool-cross-product.json` uses the `response.toolUse` and `response.text` shorthand to generate Anthropic SSE. The first-stage fixture matches `E2E_TOOL_CROSS_PRODUCT_<TOOL>` in the latest user message; the second-stage generic final fixture matches `E2E_TOOL_CROSS_PRODUCT` + `toolu_e2e_tool_cross_product` and excludes compact/title/goal continuation. So it is not hit by accident by the `tool_result` wording in the system prompt, and each tool name can be reused across the compact, fork and goal scenarios without relying on `maxMatches` counts.

## Cleanup constraints

All filesystem side effects must land in:

```text
/tmp/zcode-e2e-tool-cross-product
```

The test creates the fixture before each tool turn, and both `afterEach` and `after` run a recursive cleanup. Any new file-writing tool or shell-writing case must first enter this directory and then add the cleanup note to the matrix.
