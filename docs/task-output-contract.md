# TaskOutput tool contract

## Scope

- This spec covers only the provider-visible `TaskOutput`, its compatibility aliases, run-state
  reads, output projection and completion-notification dedupe.
- It adds no `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `remote_agent` runtime or
  ToolSearch/deferred-loading infrastructure.

## Provider-visible contract

The provider receives a single canonical tool:

```text
TaskOutput
```

The following names are local call aliases only and do not enter provider tools again:

```text
AgentOutputTool
BashOutputTool
AgentOutput
BashOutput
```

The provider-visible description must equal this text verbatim:

```text
DEPRECATED: Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes.
- For bash tasks: prefer using the Read tool on that output file path — it contains stdout/stderr.
- For local_agent tasks: use the Agent tool result directly. Do NOT Read the .output file — it is a symlink to the full subagent conversation transcript (JSONL) and will overflow your context window.
- For remote_agent tasks: prefer using the Read tool on the output file path — it contains the streamed remote session output (same as bash).

- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions
```

The input schema is a strict object:

| Field     | Provider schema                                                                | Runtime                                                                                      |
| --------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `task_id` | required string, `The task ID to get output from`                              | an empty string reports `Task ID is required`                                                |
| `block`   | required boolean, default `true`, `Whether to wait for completion`             | the default is still filled when omitted; the strings `"true"` / `"false"` are also accepted |
| `timeout` | required number, default `30000`, min `0`, max `600000`, `Max wait time in ms` | the default is still filled when omitted; unit is milliseconds                               |

Provider `input_schema.required` is fixed as `["task_id", "block", "timeout"]`. `block` and
`timeout` also keep a runtime default: `required` constrains the model-generated wire input, while the
default stays compatible with local aliases, historical calls and manual calls.

The tool is read-only, concurrency-safe and needs no approval. It declares no deferred-loading
(`shouldDefer`); ZCode does not currently implement a ToolSearch discovery mechanism.

Provider-facing input errors have two layers:

- A missing `task_id` field or a wrong field type follows the generic initial schema validation,
  returning `<tool_use_error>InputValidationError: ...</tool_use_error>` with `is_error:true`.
- An empty-string `task_id` returns `<tool_use_error>Task ID is required</tool_use_error>` with `is_error:true`.
- A non-empty `task_id` that does not exist in the registry returns
  `<tool_use_error>No task found with ID: <task_id></tool_use_error>` with `is_error:true`.

The latter two are returned by `TaskOutput`'s `validateInput` after the initial schema validation and
before `PreToolUse` as `{ result:false, errorCode:1|2, message }`. On failure `PreToolUse`, permission
judgment, the handler and `PostToolUseFailure` do not run. The executor does not recognize the specific
tool name; it only assembles the failure result uniformly and ends the tool event. The provider-facing
`modelContent` uses `<tool_use_error>`, while UI, logs and structured errors keep the raw message
without the tag.

Before actually reading, the handler re-checks the registry to cover the race where the task is deleted
after validation or a hook modifies the input; this defensive check does not change the normal task read
and wait paths.

## State and notification

`RuntimeTaskRegistry` is the single source of task existence and state:

```text
running / pending + block=false -> not_ready + current task
running / pending + block=true  -> poll every 100ms
                                   terminal -> success + current task
                                   timeout  -> timeout + latest task
                                   removed  -> timeout + task:null
terminal                         -> success + current task
```

- If the task is not found on the first lookup: `No task found with ID: <task_id>`.
- `block=true` emits one standard `ToolCallProgress` before waiting. ZCode reuses the existing progress
  schema and adds no TaskOutput-specific Protocol field; this internal projection does not affect the
  provider-visible result.
- `timeout=0` does not sleep and returns the current snapshot directly.
- abort throws AbortError.
- `notified:true` is written atomically only after the terminal output is projected successfully; a
  projection failure or abort must not consume the notification claim.
- Before the completion notification is enqueued, `notified` is likewise checked and written, so a race
  between TaskOutput and completion yields at most one `<task-notification>`.

## Output sources

- `local_bash`: semantically prefer the active shell task output's stdout and stderr joined by a single
  `\n`; when unavailable read the task output file; `exitCode` comes from the execution result.
  - A new Bash task writes stdout/stderr directly to the same canonical output file; flags, soft cap
    and lifecycle are in `docs/bash-background-parity.md`. While running, TaskOutput still reads at
    most 30000 bytes from offset 0, adds no leading-omission notice and adds no environment-variable
    override; when the file is unavailable it falls back to the execution result's inline text /
    progress tail. When the terminal or active snapshot is unavailable it uses the generic task output
    file read, at most the last 8 MiB.
  - The root shell settles on exit without waiting for descendants to close output handles. The
    registry terminal state does not promise file stability; descendants may keep writing, and a later
    query can read the late content but does not reactivate the task or resend the completion
    notification. Once the head exceeds the budget, repeated running queries may return the same
    content; the latest progress comes from Bash's bounded tail read.
  - framework error and timeout/cancel text may still exist in structured stderr. TaskOutput appends it
    after the canonical command output; because the canonical file does not contain that text, the file
    must not be described as the complete merged output in this case.
  - A historical split-path snapshot can still be read as stdout then stderr, but when two different
    files together form the result, no merged artifact is added and neither single-stream path is
    disguised as `Full output`. Oversized text is handled by TaskOutput's own 100000-character
    persistence boundary.
- `local_agent`: in a terminal state prefer the Agent result content blocks joined by a single `\n`;
  otherwise read the task output file. A missing output file does not affect task existence or state.
- Other registered ZCode task types: read the generic output file recorded in the registry.
- When the output file read fails or the file does not exist, return an empty string.
- Generic and terminal output files read at most the last 8 MiB; when the front is omitted,
  `[NKB of earlier output omitted]\n` is added. A running Bash uses the separate file-head read rule above.

`TASK_MAX_OUTPUT_LENGTH` defaults to `32000` characters, max `160000`; it is parsed with decimal
`parseInt`, so a string with a valid numeric prefix takes effect as that number; empty, unparseable or
non-positive values use the default. Over-limit output must become:

```text
[Truncated. Full output: <task-output-path>]

<kept tail>
```

When the effective limit is not smaller than the prefix length, the total character count of prefix and
tail equals the effective limit. When the effective limit is smaller than the prefix length, the original
negative `slice` boundary behavior is kept with no extra correction.

## Provider-visible result

An ordinary result is plain text. Blocks are separated by two newlines, with no XML escaping:

```text
<retrieval_status>success|not_ready|timeout</retrieval_status>

<task_id>...</task_id>

<task_type>...</task_type>

<status>...</status>

<exit_code>...</exit_code>

<output>
...
</output>

<error>...</error>
```

- When `task` is `null` only `retrieval_status` is output.
- `exit_code` is output only when the value is not `null` / `undefined`.
- When `output.trim()` is empty the whole output tag is omitted; the body uses `trimEnd()`.
- `error` is output only when truthy.
- Never output `description`, `prompt`, `result`, `output_file`, `truncated` or a JSON wrapper.

When the mapped full text exceeds 100000 characters, the full text is saved as `text/plain` (a local
artifact uses `.txt`) and a `<persisted-output>` envelope is returned to the provider; on persistence
failure the original text is kept. ZCode's generic `resultBudget` must not rewrite the TaskOutput text again.

## UI display projection

The UI-specific card uses independent completed tool metadata and does not parse or rewrite the
provider-visible text above:

- `task_id` is read directly from the tool input.
- Core generates a `task_output` display from the handler result, keeping only `retrievalStatus`, an
  optional `taskStatus` of at most 64 characters, an optional `output` of at most 2000 characters and an
  optional `truncated`.
- output keeps the first 2000 characters after `trimEnd()`; a whitespace-only output does not enter the
  display, and partial output already read while running may be shown.
- The display contains no task type, description, error, prompt, result, output path or provider XML;
  these fields also do not enter the card summary body or expanded content. The error reason of a real
  tool execution failure enters only the generic failure-state tooltip of `ToolLayout` through
  `context.errorText` formed from `ToolCallRow.error`, allowing the user to hover/copy it, and is not
  written back into the `task_output` display.
- The display enters the shared UI through the existing completed metadata and V4 `ToolCallRow.display`;
  when an old record lacks a display, only the task id and the generic tool lifecycle are shown, with no
  XML/JSON fallback or persistence migration.

This projection is only for the rendering component shared by desktop, ordinary Web and mobile remote
control; it does not change the TaskOutput handler, the state machine, the provider adapters or the
delivery semantics of desktop continuous / web remote replayable.

## Acceptance

- Provider tool name, description and input schema are exactly equal to the golden above.
- Both provider adapter chains pass the TaskOutput result text through unchanged.
- A running Agent still returns `not_ready` and `running` even with no output file yet.
- Both orderings of the race between TaskOutput reading the terminal state and the completion
  notification produce exactly one notification.
- Focused tests cover default, maximum, invalid, numeric-prefix and smaller-than-truncation-prefix
  `TASK_MAX_OUTPUT_LENGTH`, the 8 MiB file tail read, and 100000-character text persistence.
- Bash focused tests must cover the canonical output file, the fixed 30000-byte file-head read while
  running, the projection of a task still running after timeout, the inline/tail fallback, framework
  stderr, historical split-path compatibility, and the real `Full output` path corresponding to the
  canonical file.
