# Session Persistence

## Provider Format Upgrade and Rollback Readability (Todo109)

The old format reference is `staging_backup@790884b1ce`. When the Agent opens the database it converts once via
`0020_provider_model_selection`; transaction and rollback boundaries are in
[SQLite migrations](./local-setting-migrations.md).

- Old JSON members stay as rollback snapshots; the current Reader no longer parses them as a run selection.
  Saving existing messages, Parts and fork/copy preserves the old snapshot without restoring it as config.
- A missing new config member does not block reading session bodies and task content and triggers no
  default-model execution; recovery is the user re-selecting. Historical sources keep the Provider identity of
  their time; only the current Session selection uses the established migration table.
- After a rollback (or rollback then upgrade) a missing or malformed selection field must not stop a
  session/task from opening, lose its body, or raise an error report. The storage Reader structurally
  validates the new selection of User, Timeline and Subtask and projects an illegal value as missing: no
  error, no deletion of the item, no fallback to old fields, no check of current Provider availability. The
  Timeline display label is kept separately from the strict Selection contract. Committed migrations are
  neither modified nor re-run; this protection also covers records with missing fields produced during a
  rollback.
- The explicit old-session import script is also a write entry point: User must add the minimal `model`
  object the old Reader needs (not a second current selection; the current Reader ignores it). Assistant and
  other fields that need no compatible write are not dual-written.

## Conclusion

This version stays minimal: no operation journal, checkpoint table, tool call table or event store table.

Core persistence has three layers:

- `session`: session metadata and a little session-level state.
- `message`: one user or assistant message; the main data lives in a `data` JSON.
- `part`: a content block of a message; text, reasoning, file, tool, patch and compact are all parts.

Auxiliary tables:

- `todo`: the todo list within a session.
- `session_entry`: the v2 UI / event projection for a lighter timeline; not the only source for context
  recovery in the first version.
- `permission`: project-level permission rules.
- `input_history`: project-level user input history, so interactive clients can recall recently sent
  inputs.

Running state is not persisted: `SessionRunState` is an in-process map (busy, cancel, shell runner); after a
restart, the written `message` / `part` rows show whether the last run ended half-way.

## Storage

The first version uses SQLite. The TypeScript layer validates the `data` JSON with a runtime schema; the
database expands only the necessary index fields.

The physical path is `storage.sessionDbPath`, default `~/.zcode/cli/db/db.sqlite`. User config and
`ZCODE_SESSION_DB_PATH` can override it; for early dev entry points `ZCODE_SESSION_DB` is also resolved
as a synonym. Bootstrap resolves `~` and relative paths; business code must not depend on the SQLite
file name or directory structure.

Do not split every field into a column:

- Indexable, listable, joinable fields become columns.
- Business shape goes in JSON.
- message and part are separate, so updating one tool/text part does not rewrite the whole message.

## Common Fields

`message`, `part`, `todo` and `session_entry` also have these (not repeated in their tables below):

| Column | Type | Purpose |
| --- | --- | --- |
| `time_created` | integer | Creation time, ms timestamp. |
| `time_updated` | integer | Update time, ms timestamp. |

## Table: `session`

One row is one session.

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | text primary key | Session ID. |
| `project_id` | text not null | Owning project; deleting the project cascades to its sessions. |
| `workspace_id` | text nullable | Owning workspace; empty without a workspace. |
| `parent_id` | text nullable | Parent session of a fork / child session. |
| `slug` | text not null | Short identifier for URLs, file names or UI. |
| `directory` | text not null | Working directory when the session was created. |
| `path` | text nullable | Project-relative path or UI display path. |
| `title` | text not null | Session title. |
| `title_source` | text not null default `first_input` | Title source: `default`, `first_input`, `generated`, `custom`. An AI generated title can CAS-overwrite only non-custom sources. |
| `title_message_id` | text null | The user message the title was generated or set from. |
| `time_title_updated` | integer null | Last title update time. |
| `version` | text not null | ZCode CLI version at session creation; same source as `__CLI_VERSION__` injected from the root `package.json`. |
| `share_url` | text nullable | URL after sharing. |
| `summary_additions` | integer nullable | Added lines of the current revert / diff summary. |
| `summary_deletions` | integer nullable | Deleted lines of the current revert / diff summary. |
| `summary_files` | integer nullable | File count of the current revert / diff summary. |
| `summary_diffs` | json nullable | File diff summary, shaped like the snapshot file diff. |
| `revert` | json nullable | Current rewind / revert state. |
| `permission` | json nullable | Session-level permission rule override. |
| `time_created` | integer | Creation time. |
| `time_updated` | integer | Update time. |
| `time_compacting` | integer nullable | Time compaction started; prevents duplicate compact. |
| `time_archived` | integer nullable | Archive time; empty means not archived. |

Writing a `message` or `part` refreshes the owning session's `time_updated`. `--continue` and TUI
`/resume` default to the most recently active root session in the same directory, not just ordering by
creation time.

Indexes:

- `session_project_idx(project_id)`
- `session_workspace_idx(workspace_id)`
- `session_parent_idx(parent_id)`

`revert` JSON shape:

```ts
type SessionRevert = {
  messageID: MessageID;
  partID?: PartID;
  snapshot?: string;
  diff?: string;
};
```

`messageID` is the message kept up to after a rewind; `partID` (if only a middle part of an assistant message
is rolled back) is where deletion starts; `snapshot` is the filesystem snapshot ID before the rewind, used by
unrevert; `diff` is the diff text from the snapshot to the current workspace.

## Table: `message`

One row is one user or assistant message. A message does not store text directly; text and tool calls are
in the `part` table.

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | text primary key | Message ID. |
| `session_id` | text not null | Owning session. |
| `data` | json not null | `MessageInfo` business fields without `id` and `sessionID`. |

Index: `message_session_time_created_id_idx(session_id, time_created, id)`, used for stable recovery:

```sql
select * from message
where session_id = ?
order by time_created, id;
```

### `MessageInfo.User`

`id` and `sessionID` are columns and not repeated in `data`.

| Field | Purpose |
| --- | --- |
| `role: "user"` | Message role. |
| `time.created` | User message creation time. |
| `format?` | Output format requirement, e.g. text or json schema. |
| `summary?` | Whether this user message is a summary prompt; may carry title, body, diffs. |
| `agent` | Agent name used. |
| `model.providerID`, `model.modelID`, `model.variant?` | Provider, model and model variant. |
| `system?` | Extra system text for this request. |
| `tools?` | Tool switches for this request, `toolName -> enabled`. |

### `MessageInfo.Assistant`

`id` and `sessionID` are columns and not repeated in `data`.

| Field | Purpose |
| --- | --- |
| `role: "assistant"` | Message role. |
| `time.created` | Assistant message creation time. |
| `time.completed?` | Completion time; may be empty while generating or after interruption. |
| `error?` | Failure reason, e.g. abort, context overflow, provider error. |
| `parentID` | The user message this reply answers. |
| `modelID` | Model ID actually used. |
| `providerID` | Provider ID actually used. |
| `mode` | Compatibility field, deprecated. |
| `agent` | Agent actually used. |
| `path.cwd`, `path.root` | Runtime cwd and project root. |
| `summary?` | Whether this is a compact-generated summary assistant. |
| `cost` | Cost of this call. |
| `tokens.{total?,input,output,reasoning}`, `tokens.cache.{read,write}` | Token counts (`total` optional). |
| `structured?` | Structured output result. |
| `variant?` | Model variant. |
| `finish?` | Provider finish reason. |

## Table: `part`

One row is one content block of a message. Text streams, reasoning, tool state updates, files, patches
and compaction are all written as parts.

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | text primary key | Part ID. |
| `message_id` | text not null | Owning message. |
| `session_id` | text not null | Owning session, stored redundantly to query parts by session. |
| `data` | json not null | `Part` business fields without `id`, `sessionID`, `messageID`. |

Indexes: `part_message_id_id_idx(message_id, id)`, `part_session_idx(session_id)`.

Recovering one message:

```sql
select * from part
where message_id = ?
order by id;
```

### Part types

| `type` | Key fields | Purpose |
| --- | --- | --- |
| `text` | `text`, `synthetic?`, `ignored?`, `time?`, `metadata?` | User text or assistant text. |
| `reasoning` | `text`, `metadata?`, `time` | Reasoning stream. |
| `file` | `mime`, `filename?`, `url`, `source?` | User-uploaded file, image, or tool attachment reference. |
| `agent` | `name`, `source?` | Agent selected in the user prompt. |
| `tool` | `callID`, `tool`, `state`, `metadata?` | Tool call and state. |
| `step-start` | `snapshot?` | Assistant step start; may record a snapshot. |
| `step-finish` | `reason`, `snapshot?`, `cost`, `tokens` | Assistant step end. |
| `snapshot` | `snapshot` | Filesystem snapshot ID. |
| `patch` | `hash`, `files` | Workspace patch info, used for revert. |
| `compaction` | `auto`, `overflow?`, `tail_start_id?` | Compact marker. |
| `retry` | `attempt`, `error`, `time.created` | Provider retry record. |
| `subtask` | `prompt`, `description`, `agent`, `model?`, `command?` | Subagent / subtask description. |

### Tool state

The `state` of a `tool` part is a discriminated union.

| `state.status` | Fields | Purpose |
| --- | --- | --- |
| `pending` | `input`, `raw` | The model just emitted the tool call; not yet parsed or executed. |
| `running` | `input`, `title?`, `metadata?`, `time.start` | The tool started executing. |
| `completed` | `input`, `output`, `title`, `metadata`, `time.start`, `time.end`, `time.compacted?`, `attachments?` | The tool succeeded. |
| `error` | `input`, `error`, `metadata?`, `time.start`, `time.end` | The tool failed or was cancelled. |

Shell/tool output is not appended row by row at runtime; it is updated when the part state changes. For
very long bash output the first version stores a `completed.output` string; compact may truncate it for
context and mark it with `time.compacted`.

#### Completed tool metadata

`completed.output` is the model-visible result and may be only a short confirmation text; UI/ZCode
app-server/debug must not parse structured information back out of it. The `state.metadata` of a
successful tool part is versioned JSON:

```ts
type CompletedToolPartMetadata = {
  schemaVersion: 1;
  display?: ToolResultDisplayPayload;
  modelContentLayout?: Array<
    | { type: "text"; text: string }
    | { type: "attachment"; attachmentIndex: number }
  >;
  serialization?: {
    truncated: boolean;
    originalBytes: number;
    returnedBytes: number;
    budgetStrategy: "inline" | "truncate" | "artifact";
    artifactPath?: string;
  };
};
```

In the first version `display` defines only `file_diff`, aligned with live
`tool_call_result.payload.result.display`:

```ts
type ToolResultDisplayPayload = {
  kind: "file_diff";
  filePath: string;
  additions: number;
  deletions: number;
  structuredPatch: DiffHunk[];
  truncated?: boolean;
};
```

`display` is a bounded UI projection, not the full tool output. The full file content, raw output or
over-long results of `Edit` / `Write` stay under the tool output schema, result budget and
artifact/storage; SQLite keeps only the recoverable display projection and artifact references.

Compatibility:

- No SQL migration: `part.data` is already JSON, so the new fields only change the business contract.
- If an old session's completed tool part lacks `metadata.schemaVersion` or `metadata.display`, resume /
  app-server load / TUI initial transcript must keep showing the legacy `output` without error.
- Provider history cold recovery uses `attachments` to rebuild a structured tool result only when
  `metadata.modelContentLayout` is complete and valid. An old part with no layout, an illegal layout or
  an out-of-range reference must keep replaying the legacy `output`. `attachments` alone does not mean
  they belong to the new provider-visible media layout.
- Old Edit/Write data cannot reliably restore the full diff (`replace_all`, user edits in the permission
  panel, stale files, context lines); the first version does not forge a historical diff from
  `old_string/new_string`.

## Table: `todo`

The todo list within a session.

In the first version it is exposed to `TodoRead` and `TodoWrite` through `SessionStorePort.readTodos()` /
`SessionStorePort.updateTodos()`. Tool handlers depend only on the port, not on SQLite directly. The
SQLite adapter uses a transaction that first deletes the session's old todos, then writes the complete
new list by `position`, which keeps the "full plan replacement" semantics and a stable read order.

| Column | Type | Purpose |
| --- | --- | --- |
| `session_id` | text not null | Owning session. |
| `content` | text not null | Todo content. |
| `status` | text not null | Status. |
| `priority` | text not null | Priority. |
| `position` | integer not null | Sort position. |

Primary key: `(session_id, position)`. Index: `todo_session_idx(session_id)`.

## Table: `session_entry`

Projects session events into lighter timeline entries.

The first version may create the table but must not tie context recovery to it. Context recovery still
follows `message + part`.

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | text primary key | Entry ID. |
| `session_id` | text not null | Owning session. |
| `type` | text not null | `user`, `synthetic`, `assistant`, `compaction`. |
| `data` | json not null | `SessionEntry.Entry` fields without `id` and `type`. |

Indexes: `session_entry_session_idx(session_id)`, `session_entry_session_type_idx(session_id, type)`,
`session_entry_time_created_idx(time_created)`.

Entry shapes:

| `type` | Purpose |
| --- | --- |
| `user` | User input, with text, files, agents. |
| `synthetic` | System-synthesized input. |
| `assistant` | Assistant timeline, with text, reasoning, tool, retry, cost, tokens, error. |
| `compaction` | Compact event display. |

## Table: `input_history`

One row is one user input accepted by the server. It is not provider-visible message history and takes no
part in model context recovery. Clients (TUI, ZCode app-server, future GUI) recall it only through server
capabilities, never by reading the database.

The whole table keeps at most the latest 100 rows, ordered by `time_created desc, id desc`; not 100 per
project.

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | text primary key | Input history entry ID. |
| `project_id` | text not null | Owning project; recall filters by it by default. |
| `session_id` | text nullable | Session that produced the input; debug/audit only. |
| `text` | text not null | Raw user input; inputs empty after trim are not written. |
| `kind` | text not null | `prompt`, `steered_input` or `slash_command`. |
| `time_created` | integer | Creation time. |

Indexes: `input_history_project_time_idx(project_id, time_created desc, id desc)`,
`input_history_time_idx(time_created desc, id desc)`.

Write semantics:

- Consecutive duplicates are deduplicated per project (same latest `text`: no new row).
- A write deletes rows beyond the global 101st in the same transaction.
- A write failure must not block prompt submission; the caller logs a structured entry and continues.

## Table: `permission`

Project-level permission rules. The first version has only project scope, no session/global persistence.
`Allow once` in the approval UI is not written here; `Always allow in this project` is.

| Column | Type | Purpose |
| --- | --- | --- |
| `project_id` | text primary key | Project ID. |
| `time_created` | integer | Creation time. |
| `time_updated` | integer | Update time. |
| `data` | json not null | Permission ruleset, e.g. `{ "version": 1, "allow": [{ "toolName": "Bash", "ruleContent": "npm run:*" }], "deny": [], "ask": [] }`. |

## Write Strategy

Behavior boundaries:

1. Creating a session writes `session`; a user prompt writes one `message(role=user)` and several
   `part(text/file/agent)`.
2. When the assistant starts, write one `message(role=assistant)`, then a `step-start` part; when it
   finishes, update `time.completed`, cost, tokens, finish and write a `step-finish` part.
3. Text and reasoning streams update the same `part`, never a new row per token; a tool call only updates
   the same `tool` part's state: `pending -> running -> completed/error`.
4. compact, retry, patch and snapshot are parts; no dedicated tables.

Performance constraints:

- Streaming text updates are debounced (e.g. 250-500ms or a character threshold); running tool output is not
  written continuously, `completed.output` is written once on completion.
- Writes of message and part for the same stage go in one transaction; stop, crash and process exit
  force-flush the current message / part.

## Recovery Strategy

Recovering a session:

1. Read `session`.
2. Read `message` by `(time_created, id)`.
3. Read each message's `part` by `(message_id, id)`.
4. Reassemble `MessageWithParts`.
5. The context builder then decides which parts enter model context, e.g. ignore `ignored`, handle
   compact summary, trim tool output.

Never recover model context from `session_entry`; it serves UI timeline or lightweight APIs. After
`resume`, TUI, ZCode app-server or a future GUI must rebuild the historical `user / agent` transcript from
the same `message + part` (not just show a "session resumed" hint); `session_entry` may only be a
lightweight timeline / index cache, never the only source of truth.

### Resume v1 contract

The first version of resume promises to restore model-visible context, keep writing into the same
session, and give interactive clients the data to rebuild the historical transcript. It still does not
restore the in-process runner, shell, pending permission or unfinished external I/O.

Entry forms:

- `zcode --resume <sessionId>`: resume the given session. `sessionId` is `session.id`, usually
  `sess_...`, from CLI `--json` output or a session list response; never pass a `traceId`, `turnId`,
  `messageId`, `partId` or `toolCallId` to `--resume`.
- `zcode --continue` / `zcode -c`: resume the most recent unarchived root session of the current
  directory.
- `--resume` and `--continue` are mutually exclusive.
- If the given session does not exist, is archived, or its message/part data is corrupt, the CLI returns
  a structured session error and does not silently create a new session.

Recovery flow:

1. Read the `session` metadata and switch the runtime `workingDirectory` to `session.directory`.
2. Initialize the current version's system/context sections. Dynamic context such as AGENTS.md, tool
   declarations and environment info is re-resolved on resume, not copied from the old transcript.
3. Read `message + part` and derive the active chain by the compact rules.
4. Convert the active chain into provider-visible `MessageHistory`.
5. Mark `sessionPersisted = true`; later turns keep writing into the original session.
6. Append a `session_resumed` event and a structured log recording restored message count, part count,
   interrupted tool count and restored directory.

Provider-visible recovery rules:

- A `user` message concatenates only non-`ignored` `text` parts; the first version keeps only a readable
  placeholder for `file` parts (multimodal recovery comes later).
- An `assistant` message concatenates `text` parts; `tool` parts convert back into assistant tool calls.
- A `completed` tool part becomes a successful tool result; with `state.attachments`, the
  provider-neutral media blocks are rebuilt in order from artifacts, otherwise `state.output` is used.
- An `error` tool part becomes a failed tool result.
- A `pending` / `running` tool part always becomes a failed tool result with content
  `[Tool execution was interrupted before resume]`, so the provider never receives a dangling tool call.
- An unfinished assistant message with no valid text, reasoning or tool part does not enter model
  context.

Compact recovery:

- If a `compaction` part exists, the active chain starts at the last `compaction` message.
- If `compaction.tail_start_id` exists, a later implementation may restore summary + tail; the first
  version truncates at the last compaction boundary, so restarting after compact does not push old
  history back into context.
- If compaction metadata is corrupt, load the parseable messages conservatively and write a structured
  warning; a later turn may compact again.

`--continue` filters by the current directory:

- The first version uses unarchived root sessions with `session.directory = cwd`.
- Later, with worktree / project-relative `path` support, it can extend to `path` prefix matching.

## Edge Cases

### User stops model generation

Running state is not in the database; the in-process `SessionRunState` handles cancel. Persisted result:

- Generated text/reasoning parts keep the content of the last flush.
- The assistant message may have no `time.completed`.
- If the interruption is handled explicitly, the assistant message gets an `error`, e.g. aborted.
- A running tool part is updated to `error` when cancellable; if not cancellable or the process crashed,
  recovery sees `running` with no process runner and shows it as interrupted/stale.

No `run` table is needed.

### Context too long, compact needed

Compact is also message/part, not a separate table.

Flow:

1. Set `session.time_compacting` to prevent duplicate compact.
2. Insert a user message containing a `compaction` part, then an assistant summary message with
   `summary: true`; `compaction.tail_start_id` points to the tail messages kept.
3. Mark old tool output no longer needed in context with `time.compacted` on the tool state.
4. Clear `session.time_compacting`.

When recovering context, the context builder uses the summary message plus tail messages instead of
re-reading the full history.

### Multimedia resources

Multimedia is not stuffed into message text.

- User-uploaded or tool-produced files use `file` parts.
- `file.url` points to a resource in storage/artifact.
- `mime` decides whether the model treats it as image, text, audio, etc.
- `source` records the origin, e.g. workspace file, symbol, MCP resource.
- Tool results with attachments put them in `ToolStateCompleted.attachments`, also `FilePart[]`.

The database stores references and metadata; binary content goes to storage/artifact.

`FilePart + artifact` is the cross-provider source of truth. base64 belongs only to the current provider
request projection and must not be the only persisted content of a message/tool part. Switching
model or provider within a session, and cold recovery after exit, must regenerate the wire form the
current provider needs from the artifact. A media artifact write failure therefore must not silently
become an unrecoverable completed tool part.

### Very long Bash output

On completion `completed.output` is a string.

The first version adds no `tool_output` table. Rules:

- While running, keep only an in-memory buffer and UI preview; do not write to the database often.
- Write the `tool` part once on completion.
- When entering model context, truncate by the tool output budget.
- After compact, mark `time.compacted` to show the old output has been absorbed by the summary.

If SQLite size becomes a real bottleneck, `output` can later become an artifact reference (not the first
version).

### User rewind / revert

Uses the session-level `revert` field; no table per checkpoint.

Revert flow:

1. `assertNotBusy(sessionID)`; rewind is not allowed while busy.
2. Find the target `messageID` / `partID`.
3. Record the current snapshot into `session.revert.snapshot`.
4. Collect the `patch` parts after the target and roll back the filesystem.
5. Compute the diff summary and write `summary_additions`, `summary_deletions`, `summary_files`,
   `summary_diffs`.
6. If the user confirms cleanup, delete the messages after the target; with a `partID`, delete the parts
   from that part on within the same message.
7. Clear `session.revert`.

Unrevert:

1. If `session.revert.snapshot` exists, restore the snapshot.
2. Clear `session.revert` and the summary.

### Fork session

The new session's `parent_id` points to the original; `directory`, `path`, `permission` may be initialized
from the parent. Whether message/part are copied is a product choice (copy if history is edited independently
after the fork; otherwise the context builder reads the parent chain). The first version recommends copying:
simple, offline, easy to understand.

### Crash recovery

The in-process runner is not restored. An assistant message without `time.completed` is marked interrupted;
a `running` tool part is marked stale/interrupted (the user may retry); `time_compacting` is cleared and
compact re-evaluated; a session with `revert` shows the cleanup / unrevert state.

## ZCode First-Version Interface

The persistence module exposes only:

```ts
interface SessionStore {
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  updateSession(input: UpdateSessionInput): Promise<SessionInfo>;
  getSession(sessionID: SessionID): Promise<SessionInfo>;
  listSessions(input: ListSessionsInput): Promise<SessionInfo[]>;

  saveMessage(input: MessageInfo): Promise<void>;
  removeMessage(input: { sessionID: SessionID; messageID: MessageID }): Promise<void>;

  savePart(input: MessagePart): Promise<void>;
  removePart(input: { sessionID: SessionID; messageID: MessageID; partID: PartID }): Promise<void>;

  messages(input: { sessionID: SessionID }): Promise<MessageWithParts[]>;

  setRevert(input: {
    sessionID: SessionID;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void>;
  clearRevert(sessionID: SessionID): Promise<void>;
}
```

Business code depends only on this interface, never on SQLite, fs or an ORM.

## Runtime Integration Contract

The `core` prompt loop expresses persistence intent only through the `SessionStore` port. It does not
depend on SQLite, file paths, table structure or adapter internals.

- Each runtime instance calls `createSession` once, on its first turn. The session `directory`/`path`
  come from the runtime config `workingDirectory`, falling back to the process directory only when unset.
- With the local TUI explicitly enabled, the runtime may start a session title sidecar request after the
  first real user turn completes. Headless `--prompt`, `--target` and ZCode app-server do not enable it by
  default, so scripts and protocol scenarios get no extra background model call. Title generation uses
  `ModelRole.Lite`; without `model.lite` it resolves to the current default/main model. Writing back
  `session.title` must carry `expectedTitleSources`, so a late generated title cannot overwrite a user
  custom title. Full contract: [`session-title-generation.md`](./session-title-generation.md).
- Each user input first saves a `user` message, then a text part; attachments are saved as file parts.
  The message and parts share one `traceId`, to tie them to the event log and logs.
- Each model request creates an `assistant` message, first saved in an unfinished state, then saves
  text/tool/step parts per the response, and finally writes back `time.completed`, `finish` and token
  stats under the same message id.
- A tool call part is written with the same part id through `pending`, `running`, `completed` or `error`.
  The adapter can thus express the final state with upsert semantics, and logs show the intermediate
  states.
- A tool completed part must persist bounded display metadata from the same source as the live result
  event. For example the `Edit` / `Write` file diff comes from `tool_call_result.result.display` in live
  TUI and from `part.state.metadata.display` on resume; the two must not diverge.
- When `sessionStore` is not configured, the runtime must keep working with the event store alone; when
  configured, persistence errors bubble up by default so the CLI entry formats the failure uniformly, and
  core does not swallow half-persisted problems.
- Each successful `createSession`, `saveMessage`, `savePart` writes a structured debug log with at least
  `traceId`, `sessionId`, `turnId`, message/part id and event name.

## Implementation Order

Fix the `SessionInfo`, `MessageInfo`, `Part`, `SessionStore` schema first, then: SQLite adapter and migrations;
prompt loop (user message, assistant message, part updates); resume from `message + part`; stop (flush the
current part, clean the in-memory runner); compact (`compaction` part + summary assistant); revert
(`session.revert` + snapshot + patch cleanup).

The persistence mainline: few tables, message/part JSON carrying business structure, run state in memory, and
compact/revert expressed through existing message/part/session fields.
