# Skill / Command Availability Override (config.json)

## Goal

`config.json` can disable a single skill or custom command by **absolute path**. Disabled entries are dropped
during discovery, so the agent sees only the filtered "actually available" set.

## Config format

The key is the absolute path of the `.md` file (`SKILL.md` for skills, the command `.md` for commands):

```json
{
  "skill": {
    "/Users/me/.zcode/skills/demo/SKILL.md": { "enable": false }
  },
  "command": {
    "/Users/me/.zcode/commands/demo.md": { "enable": false }
  }
}
```

Semantics:

- Only entries with an explicit `"enable": false` are filtered; **unlisted entries stay available**.
- The fields go through the shared config pipeline, so any scope (user `~/.zcode/cli/config.json`,
  project `.zcode/config.json`, ...) can set them; scopes merge by path key, higher priority wins.

## Implementation chain

1. **schema** (`packages/adapters/src/config/schema.ts`): `ZCodeConfigFileSchema` has `skill` /
   `command` fields of type `Record<path, { enable?: boolean }>`; `parseConfigFileToRuntimePatch` maps them
   to `skillOverrides` / `commandOverrides`.
2. **contracts** (`packages/contracts/src/config/index.ts`): `ConfigKey.SkillOverrides="skill"` /
   `CommandOverrides="command"`, and `RuntimeConfig.skillOverrides` / `commandOverrides` (default `{}`).
3. **store** (`packages/adapters/src/config/index.ts`, `config-merger.ts`): merge writes into the store,
   `getRuntimeConfig` assembles them, and scopes deep-merge by key.
4. **adapter filtering** (`packages/adapters/src/skills/index.ts`, `commands/index.ts`): a `disabledPaths`
   option; `discoverSkills` / `discoverCommands` skip a parsed entry that matches. `loadSkill` /
   `loadCommand` / inspect all reuse discover, so filtering is consistent across the whole chain.
5. **bootstrap** (`packages/bootstrap/src/skills.ts`, `custom-commands.ts`): collects the paths with
   `enable:false` from `config.skillOverrides` / `commandOverrides` and passes them to the adapter.

## Tests

- `packages/adapters/tests/config.test.ts`: the JSON `skill`/`command` fields map to runtime overrides.
- `packages/adapters/tests/skills.test.ts`, `commands.test.ts`: `disabledPaths` filters matching entries and
  `load*` of a disabled entry throws not found.
