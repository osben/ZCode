# TodoRead / TodoWrite Tool Design

## Goals

Todo tools turn a long-task plan into first-class session-level state, instead of relying only on a markdown list in assistant text. They serve three production goals:

- Long tasks can continue: after resume the current task list can still be read.
- Progress is observable: TUI, ZCode app-server, logs and later session projections can render the plan from the same state source.
- The model is constrained: at most one `in_progress` at a time, so parallel narration does not drift from real execution.

## Tool split

### TodoRead

Reads the current session's todo list.

Input:

```ts
{}
```

Output:

```ts
{
  todos: TodoItem[];
}
```

Permissions and side effects:

- `readOnly: true`
- `sideEffectScope: "none"`
- `riskLevel: "low"`
- No approval needed.

### TodoWrite

Replaces the current session's todo state with a full list. The model should submit the complete list every time, not an incremental patch.

Input:

```ts
{
  todos: TodoItem[];
}
```

Output:

```ts
{
  oldTodos: TodoItem[];
  todos: TodoItem[];
  summary: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
  };
}
```

Permissions and side effects:

- `readOnly: true`: touches no workspace, git, network or system; it only updates session state.
- `sideEffectScope: "session"`
- `riskLevel: "low"`
- No approval needed.
- Not concurrency-safe: within one session a later write overwrites an earlier one.

## TodoItem schema

```ts
type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
};
```

Field trade-offs:

- `content` + `status` are the minimum fields of a plan entry.
- `priority` matches the session `todo` table of ZCode v2 `session-persistence.md`.
- A display-text field for in-progress items (`activeForm`) is not introduced for now, to keep the first-version storage schema and model schema from diverging; it will be added as an L2 extension field when the UI needs in-progress display text.

## Validation rules

- `content` must be a non-empty string.
- `status` must be `pending`, `in_progress` or `completed`.
- `priority` must be `high`, `medium` or `low`.
- At most one `in_progress` in one list.
- An empty list is valid and means clearing the session todo state.

## Storage contract

Todo state lives in `SessionStorePort`, implemented by the storage adapter; the tool handler does not access a database or filesystem directly.

Candidate port:

```ts
readTodos({ sessionID }): Promise<TodoItem[]>
updateTodos({ sessionID, todos }): Promise<void>
```

The SQLite adapter keeps using the `todo` table already defined in `session-persistence.md`. `TodoWrite` first deletes the session's old todos in a transaction, then writes the new todos by list position, so read order is stable.

## Failure paths

- `SessionStorePort` not configured: `configuration_error`.
- Storage write failure: bubbles up as a storage/configuration-related error, and the executor records a tool error event.
- Schema validation failure: the executor returns a structured tool error and session state is not updated.

## L2 landing scope

### Implementation check (2026-05-08)

This check confirms the Todo toolchain has advanced from the minimal contract to a complete projection loop; do not re-implement these capabilities as pure plan items:

- contracts: Zod runtime schema, JSON Schema derived from a shared helper, `todoItemsFromToolResultContent()` and `formatTodoStateForModel()` landed in `packages/contracts/src/tools/todo.ts`.
- core: the `TodoRead` / `TodoWrite` tool entries, session store port calls, duplicate `in_progress` validation and public tool contract declarations landed in `packages/core/src/tool/handlers/todo.ts`.
- storage adapter: SQLite todo replace-write and stable-order read landed in `packages/adapters/src/storage/session-store.ts`.
- TUI projects the todo panel from the `ToolCallResult` runtime event per `docs/design/v2/tui-todo-display.md`; the TUI does not read the session store directly.
- ZCode app-server: the bootstrap layer projects a successful `TodoRead` / `TodoWrite` result as a structured `sessionUpdate: "plan"`, and replays the persisted todo plan on `resumeSession` and before an ordinary `prompt`.
- resume reads todos from `SessionStorePort.readTodos()`, injects a non-persisted `<system-reminder>`, and carries `resumedTodoCount` in the `SessionResumed` payload.
- manual, auto and reactive compact share `compactActiveConversation()`, which reads the current todos before persisting the summary and appends non-empty todo state to the summary body.

Covering tests: `packages/core/tests/todo-tool.test.ts`, `packages/adapters/tests/session-store.test.ts`, `packages/core/tests/runtime-tool-loop.test.ts`, `packages/core/tests/runtime-compact.test.ts`, `packages/tui/tests/tui.unit.test.ts`, `packages/bootstrap/tests/zcode-protocol.test.ts` and `packages/core/tests/tool-contracts.test.ts`.

Implemented in the first version:

- contracts: runtime schema, JSON schema, output types, session store todo port.
- core: `TodoRead` / `TodoWrite` tool entries, schema validation, session store calls.
- adapters: SQLite todo read/write.
- tests: storage persistence, tool handler success path, duplicate `in_progress` failure path, tool contract projection.

TUI projection:

- `docs/design/v2/tui-todo-display.md` defines how the TUI projects the current todos from the `tool_call_result` events of `TodoRead` / `TodoWrite`.
- The TUI does not read the session store directly; it only consumes the serialized `{ todos }` output in runtime events.
- The first version places the todo panel below the ordinary input and keeps its height bounded.

ZCode app-server projection:

- The `plan` update of a ZCode protocol client accepts only structured `entries` and cannot rely on parsing the `TodoRead` / `TodoWrite` JSON string out of the generic `tool_call_update.rawOutput`.
- The bootstrap layer records `toolCallId -> toolName`, parses the serialized output after a successful `TodoRead` / `TodoWrite` tool result, and additionally sends a full `sessionUpdate: "plan"`:

```ts
{
  sessionUpdate: "plan";
  entries: Array<{
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress" | "completed";
  }>;
}
```

- `tool_call_update` is still sent normally, keeping logs and the generic tool UI complete; `plan` is the dedicated projection for the ZCode app-server todo/plan UI.
- If the tool result is truncated, the JSON is invalid or the schema does not match, no `plan` is sent, so an incomplete state is not projected as the authoritative plan.
- After `loadSession` / `resumeSession` restores a session successfully, if the session store already holds todos, a persisted `plan` is also sent once, so the ZCode protocol client can restore the plan panel without a new tool call.
- A persisted `plan` is also re-sent before an ordinary `prompt` starts. The ZCode protocol client clears the previous turn's plan UI first when the user asks again, so the agent must proactively replay the current session todos; otherwise the panel disappears when the second message triggers no TodoRead/TodoWrite.

Model context recovery:

- `resumeFromStore` reads the current todos from `SessionStorePort.readTodos` and injects a non-persisted `<system-reminder>` user message.
- The injected content uses `Current session todo state (authoritative):` as a machine-recognizable title and lists each item as `[status][priority] content`, reminding the model to treat it as the authoritative short-term plan unless a later `TodoRead` / `TodoWrite` updates it.
- The `SessionResumed` event carries `resumedTodoCount` for logs and UI observation.
- When the todo read fails, `todo.context.read.failed` is logged and resume itself continues.

Compact:

- Manual, auto and reactive compact read the current todos before persisting the summary.
- Non-empty todos are appended to the compact summary body, so plan state is not lost when resuming or continuing the conversation after compaction.
- With no session store, empty todos or a read failure, the original summary is left unchanged.
