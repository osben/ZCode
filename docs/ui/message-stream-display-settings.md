# Message Stream Display Settings

Two switches in General settings independently control what the conversation detail message stream shows:

- `messageStreamShowReasoning`: when on, all reasoning / thought rows show; when off, each assistant turn
  still shows its first reasoning and later reasoning is hidden.
- `messageStreamShowTodos`: when on, Todo tool cards show; when off, they do not.

All four combinations must hold: the first reasoning always shows; "Show thinking process" controls only
later reasoning of the same turn, and "Show todos" controls Todo independently. A setting change reaches
the row-render context of the V4 `SessionPane` through the shared settings snapshot; the `rowId` of each
turn's first reasoning is derived by `ConversationTurnGroup` from the turn's full ordered rows and copies
no renderer-local visibility state.

"Show thinking process" defaults to on for new users. The version that switched the default runs a one-time
migration with `messageStreamShowReasoningMigrationInitialized`:

- An old `setting.json` without the migration marker is migrated to `true` whatever the original
  `messageStreamShowReasoning` (`true`, `false` or missing), and marker and result are persisted atomically
  through the settings service's serial write queue.
- Once the marker exists, `true` / `false` on disk is the authoritative user choice; if the user turns it
  off again, later reads and upgrades must not turn it back on.
- A fresh install resolves directly to `messageStreamShowReasoning=true` with the migration done; the first
  normal settings write persists both fields.

```text
settings read
  |
  +-- migration marker missing --> force reasoning on --> persist marker
  |
  +-- migration marker present --> preserve stored true/false
```

The two switches only trim UI rendering; they do not modify the CLI projection, session snapshot, tool
results or persisted messages. `ConversationStatusPanel` keeps showing the session progress summary by
`plan` / `todoGroups`, unaffected by `messageStreamShowTodos`. Desktop `desktop-continuous` and mobile Web
`web-remote-replayable` share the same rendering rule; the switches take no part in transport, recovery,
queue or workspace identity decisions.
