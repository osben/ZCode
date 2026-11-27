# zcode-rs: imported history on `session/create`

Status: implemented on `fix/rust-imported-history` (2026-11-26).

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
6. `importedHistory.source = "sharedContext"` is still refused with `-32602 importedHistory (sharedContext) is not
supported by this agent`, before anything is created (see Known differences).
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

- `sharedContext` is not ported. It needs `commitSharedContextImportBundle` (a `v4/shared_context_import`
  `session_entry`, a hidden model-only message) and the first-send attach flow that turns the pending context into model
  context. Rust has only the read side (hydration skips an unattached context). Refused instead of dropped.
- The generator script mirrors the Node call sequence instead of calling `persistImportedSessionHistory`, which
  is not exported and needs a full protocol server. If the Node function changes, rerun and diff the golden.
- Node's `removePreviousImportedSessionHistory` is not ported: a legacy create refuses an existing id, so there is
  nothing to remove.
- `fork_incognito` is written by the create path (`incognito` payload), not by the import. Verified only through
  the existing create tests, not through an import-specific one.
- The reopen closes the runtime once without announcing `unloaded` to the Host; the Host sees the second `ready`.
