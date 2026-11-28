# zcode-rs: imported history on `session/create`

Status: `claudeCode` implemented (2026-11-26). `sharedContext` and the previous-import cleanup: in progress, see "Shared context" below.

## Background

The desktop Host imports a Claude Code session as a ZCode task by calling the legacy `session/create` with
`importedHistory` (`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:1426` for a legacy snapshot upgrade,
`:3222` for the explicit import). Until now zcode-rs answered `importedHistory is not supported by this agent`
(`packages/rust-cli/crates/protocol-zcode/src/fork/legacy_session.rs`), so the import failed whenever the Rust agent
was selected. The Host parses the Claude Code transcript itself
(`packages/services/src/session/claude-native/claudeNativeSessionImportParser.ts`, see `specs/external-sessions.md`),
so this agent never reads a Claude Code file.

## Node reference

- Schema: `zcodeSessionImportHistorySchema`, `packages/shared/src/zcode-protocol/index.ts:1198`. Two sources.
  `claudeCode`: `{title?, createdAt?, updatedAt?, messages: [{role: user|assistant, content: string, timestamp?}]}` (at
  least one message). `sharedContext`: a markdown context from a conversation share.
- Create: `createSessionWithProjection`, `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:1452`
  calls `persistImportedSessionHistory` (`:1083`) and then `record.app.resume()`, so the session is a continuable ZCode
  session from its first moment.
- Rows written for `claudeCode` (`:1214-1296`), in the shared `db.sqlite`:
  - `session`: `title = title.trim() || "Imported session"`, `title_source = "custom"`,
    `slug = slugifyImportedSession(id)`, `time_created = createdAt ?? messages[0].timestamp ?? now`,
    `time_updated` and `time_title_updated = max(created, updatedAt ?? last timestamp ?? created)`,
    `permission = {mode}`, `fork_incognito` from `incognito`.
  - per message `i`: a `message` row `msg_<sessionId>_import_<i>` and one `text` part
    `part_<sessionId>_import_<i>_text` (`metadata.migrationSource = "claudeCode"`, `time.start = time.end = stamp`).
    User row: `{role, time.created, agent: "zcode-agent", modelSelection?, metadata.migrationSource}`. Assistant
    row: `{role, time {created, completed}, parentID (last user id, else msg_<id>_import_parent_<i>), modelId,
providerId, mode, agent, path {cwd, root}, cost 0, tokens 0, finish "stop"}`. `modelSelection`, `modelId` and
    `providerId` are present only when the session has a model.
  - timestamps: `message.timestamp ?? created + i`, then forced strictly increasing (array order wins).
  - dropped: tool calls, tool results, attachments, thinking, reasoning, system text. The payload carries only
    `role`, `content` and `timestamp`; the Host's parser removed the rest before the call. There is no
    `session_entry` row and no `anchor` or `semantics` on the messages.
  - `removePreviousImportedSessionHistory` (`:1056`) clears earlier import rows of the same session. The create
    refuses an existing id, so it never has rows to clear on a fresh create.
- First turn after the import: nothing special. The messages are ordinary stored text rows, so cold hydration puts
  them in the model context in order. The next user input starts a normal turn on top of them.

## Product rules

1. `session/create` with `importedHistory.source = "claudeCode"` stores the session and the history exactly as the
   Node reference above, in one transaction (a deferred draft gets its row in the same transaction).
2. The import persists the session whatever `persistence` says (Node stores the imported rows at creation).
3. After the write, the runtime created for the draft (empty history) is closed and the session is opened again, so
   it loads the stored history (the equivalent of Node's `app.resume()`).
4. `modelSelection` / `modelId` / `providerId` come from the session's stored model selection without its
   options (Node derives them from the `provider/model` string); `mode` is the session's execution mode;
   `path.cwd` and `path.root` are the session row's directory.
5. A failed import leaves no half-created id behind: the draft is discarded, the runtime closed, the Host gets the
   generic error `importing the session history failed` (no storage text), and a retry with the same id is accepted.
6. `importedHistory.source = "sharedContext"` is stored and attached as described in "Shared context" below. Until the
   last slice of that section ships it is still refused with `-32602 importedHistory (sharedContext) is not supported
by this agent`, before anything is created.
7. Rows Node wrote load here and rows written here load in Node: `data` of every message and part row is equal to
   Node's byte for byte (`fixtures/imported_history_golden.json`).

## State owner and interface

- Owner: `node-store` (`crates/node-store/src/import_history.rs`). It is the only writer of the imported rows.
- Port: `StoreQueries::import_history(session, &ImportedHistory)` in `rust-cli-kernel-api` (default `Unsupported`).
  `ImportedHistory {title, created_at, updated_at, messages: [ImportedMessage {assistant, content, timestamp}]}`.
- Protocol: `legacy_session.rs::create` parses the params, calls the port, then closes and reopens the live session
  (`import`). No new RPC method, no new table, column, migration or `setting.json` key.

## Acceptance cases

- `node-store` `import_history_tests.rs`: the rows equal Node's (session columns, message and part `data`,
  `time_created`); a Node-written import loads to the expected messages, model and `end_turn` finish; the Rust-written
  import loads to the same; a draft is persisted by the import; a blank title and missing times fall back; an
  unknown session is `NotFound`.
- `protocol-zcode` `legacy_session_tests.rs`: a `claudeCode` create calls the port once with the parsed history, closes
  the empty runtime and opens the session again without a second persist; a failed import discards the draft and
  frees the id; `sharedContext` is refused before the kernel.
- `crates/cli/tests/draft_prewarm.rs`: with the real kernel the reopened session's view holds the imported messages
  and the title, while the first open (before the reopen) was empty.
- Regenerating the golden: `fixtures/gen-imported-history.mts` runs Node's `SqliteSessionStore` with the call sequence
  of `persistImportedSessionHistory`.

## Known differences

- The generator script mirrors the Node call sequence instead of calling `persistImportedSessionHistory`, which
  is not exported and needs a full protocol server. If the Node function changes, rerun and diff the golden.
- Node's `removePreviousImportedSessionHistory` is ported, but it never finds rows: a legacy create refuses an
  existing id, so a fresh session has no earlier import rows.
- `fork_incognito` is written by the create path (`incognito` payload), not by the import. Verified only through
  the existing create tests, not through an import-specific one.
- The reopen closes the runtime once without announcing `unloaded` to the Host; the Host sees the second `ready`.

## Shared context (`importedHistory.source = "sharedContext"`)

Node reference (all under `apps/zcode-cli/packages`):

- Import: `persistImportedSessionHistory`, `bootstrap/src/zcode-protocol/server-operations.ts:1112`, calls
  `SqliteSessionStore.commitSharedContextImportBundle` (`adapters/.../sqlite-session-store.ts:656`): one transaction
  writes the session row, one hidden message with one text part, and one `session_entry`.
- Attach: `promoteSessionInput` (`adapters/.../repositories/session-inputs.ts:190`) runs in the transaction that
  stores the user message. When `metadata.inputIntent.sharedContextRefs[0]` names the context, the entry goes to
  `attached` (with `attachedMessageId`) and the context message gets `metadata.sharedContextStatus = "attached"`.
  It throws `shared context import is missing` or `... is no longer attachable` and rolls the message back.
- Reserve and revert: `bootstrap/src/zcode-protocol/v4-bridge.ts:1202` (admission) and `:1258` (`cancelInputCommand`).
- Discard: the v4 command `discardSharedContext` (`commands/handlers/session-mgmt.ts:312`).
- Model context: `core/src/runtime/methods/turn.ts:733` adds the context text to the history before the input,
  unless a `shared_context` entry is already there.
- Projection: snapshot `sharedContextImport` (`zcode-protocol-v4/cold-event-merge.ts:91`), delta
  `state.updated {sharedContextImport}` (`product-projection.ts:2798`).

### Rules

1. The import writes, in one transaction and with the same bytes as Node (golden: `fixtures/shared_context_golden.json`):
   - the session row: `title` = the share title (trimmed by the schema), `title_source = "custom"`,
     `slug = slugifyImportedSession(id)`, `time_created = time_updated = time_title_updated = createdAt ?? now`;
   - message `msg_<sessionId>_shared_context` (role user, `synthetic`, `source "shared_context"`, `visibility
"model-only"`, the `semantics` object of Node, `metadata {shareId, contextId, sharedContextStatus}`, and
     `modelSelection` when the session has a model) with part `part_<sessionId>_shared_context_text` (the markdown,
     `metadata {sharedContext: true}`);
   - `session_entry` `v4_shared_context_import:<sessionId>:<shareId>`, type `v4/shared_context_import`, `data` =
     the provenance in schema key order with `contextId` (default `legacy-shared-context-<sessionId>`) and `status`
     (default `pending`).
     Strings the schema trims (`title`, `shareId`, `contextId`, `artifactId`, `workspaceRelativePath`) are stored trimmed.
2. A second import of the same bundle into an existing session writes nothing (Node returns the existing row); a
   session without its entry is an error ("Shared context import session is incomplete").
3. `removePreviousImportedSessionHistory` runs before the `claudeCode` rows are written: it deletes the session's
   messages that look imported (id `msg_import_<n>` or prefix `msg_claude-import-`, or a `metadata.migrationSource` on
   the message or one of its parts equal to the source), parts with them.
4. Attach happens in the transaction of the user message the input becomes. An input with `context_refs` carries
   `sharedContextRefs` on its intent (stored in `metadata.inputIntent` and `conversationInputIntent` like Node). The
   store attaches from `pending` or `reserved`; any other status, or a missing entry, fails the message commit.
5. A queued admission (delivery other than `startNow`) with `context_refs` first moves the entry `pending` to
   `reserved` with `sourceId = queue_<commandId>`. If that fails the command is answered `failed`, reason
   `fault.command.executionFailed`, message `fault.command.sharedContextNotAttachable` (Node throws a plain Error),
   and nothing is admitted. A `startNow` input is not reserved.
6. When the kernel refuses an admitted input, the reservation goes back: `reserved` with that `sourceId` becomes
   `pending` again (Node `cancelInputCommand`). `sourceId` stays on the entry, as in Node.
7. `discardSharedContext {contextId}` moves `pending` to `discarded`; any other state answers `failed`, reason
   `fault.command.inputRejected`, message `shared context is not pending`. The context message stays stored and is
   never put in the model context.
8. Model context: the turn that carries the ref puts the context text in the history before the input, once (not when
   a `shared_context` message is already in the history). The stored message is not written again. A cold open of an
   `attached` session loads the message in the same place (it sorts by its creation time, before the first input) and
   it is hidden from the rows like Node's `uiVisibility: "hidden"`.
9. Snapshot: `sharedContextImport` is `{contextId, title, shareUrl, status}` when the entry has a `contextId`, a
   `shareUrl` and a known status, `{title}` for an older entry, absent when the session has no shared context message.
   Deltas `state.updated {sharedContextImport}` follow reserve, attach (the turn start of the input with the ref, from
   `pending` or `reserved`) and discard, and carry the same object.

### Event order

```
create(sharedContext) --> entry pending, message status pending (hidden, not in model context)
      |
      +-- discardSharedContext ----------------------------> discarded   (terminal)
      |
      +-- sendText(context_refs), queued --> reserved(sourceId = queue_<cmd>)
      |        |  kernel refuses / admission cancelled
      |        +--------------------------------------------> pending
      |        |  input promoted: user message commit (one transaction)
      |        +--------------------------------------------> attached(attachedMessageId)
      |
      +-- sendText(context_refs), startNow -----------------> attached (at the user message commit)
```

### State owners

- `node-store` `shared_context.rs`: the only writer of the bundle rows, the status transitions and the attach. It
  does not call the kernel. The user message commit (`append.rs`) calls its attach for the message's intent.
- `kernel-api` `StoreQueries`: `import_shared_context`, `transition_shared_context`, `shared_context_state` (default
  `Unsupported` / `None`).
- `protocol-zcode`: parses the params, reserves and reverts around the admission (`send_text`), answers
  `discardSharedContext`, builds the snapshot field and the deltas.
- `session`: puts the context text in the model history for the turn with the ref.

### Acceptance cases

- `node-store` `shared_context_tests.rs`: the bundle rows equal the golden (default and padded-input cases); the
  transitions leave the entry and message `data` equal to the golden steps (`reserve`, `reserve_again` refused,
  `revert`, `attach`, `discard`, `discard_again` refused, `recommit`); an attach with a missing or discarded entry
  fails the message commit and stores nothing; a Node-written attached import loads with the context message in
  order, a pending one without it; `removePreviousImportedSessionHistory` removes seeded import rows and keeps real
  ones.
- `protocol-zcode` `legacy_session_tests.rs`: a `sharedContext` create calls the port once and reopens like
  `claudeCode`; `commands_tests.rs`: reserve on queued admission, refusal text, revert on a refused submit,
  `discardSharedContext` ok and refusal; snapshot field and deltas.
- `session` `input_tests.rs`: the turn with a ref has the context message before the input, once.
- `crates/cli/tests/draft_prewarm.rs`: with the real kernel a `sharedContext` import reopens with its snapshot field.
