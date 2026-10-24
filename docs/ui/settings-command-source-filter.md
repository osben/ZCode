# Settings Command Source Filter

The "Commands" section in Settings manages user-defined slash commands by ZCode Agent source.

## Source

- `zcodeAgent`: user command directory `~/.zcode/commands`, project command directory
  `<workspace>/.zcode/commands`. During the migration period the service layer still keeps the
  `claudeCli`, `opencodeCli` and `geminiCli` descriptors for explicitly reading old directories and testing
  old file formats, but the UI no longer exposes these sources. When `agentSource` is not passed, all reads
  and writes default to `zcodeAgent`.

## File Format

- `zcodeAgent` uses Markdown command files, supporting `description` and `argument-hint` in frontmatter.
- The old `claudeCli`, `opencodeCli` and `geminiCli` formats are kept only for explicit compatibility reads,
  not as a product entry.

## Service Contract

`list`, `writeCommandFile`, `updateCommandFile`, `deleteCommandFile` and `getPrimaryUserCommandsDirectory`
of `ICommandsService` accept an optional `agentSource`. When omitted it defaults to `zcodeAgent`, and `list`
without it returns only ZCode Agent commands.

`UserCommand.id` contains source, scope and command name, e.g. `zcodeAgent:global:/review`, keeping it
distinct from historical IDs while the new UI works only on ZCode Agent commands.
