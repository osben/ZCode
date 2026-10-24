# 10 · Plugins

Plugins distribute extensions such as skills, custom commands, Hooks and MCP. The CLI supports installation and marketplace management, not only local directories. The number, versions and default enabled state of plugins change; go by the listing.

## Common commands

```sh
zcode plugins list --json
zcode plugins list --available --json
zcode plugins marketplace list --json
zcode plugins marketplace add /absolute/path/to/marketplace
zcode plugins install example-plugin@example-market --scope user
zcode plugins enable example-plugin@example-market
zcode plugins disable example-plugin@example-market
zcode plugins update example-plugin@example-market
zcode plugins uninstall example-plugin@example-market --keep-data
zcode plugins marketplace update example-market
zcode plugins marketplace remove example-market
```

The example marketplace and plugin must exist first. `--scope` supports `user` and `project`; when changing project enablement, specify the matching working directory. Install, enable, update and uninstall are different operations; after completing one, check the listing again and verify with a new process.

`plugins list` can trigger preparation of built-in plugins on its own, without first running a model conversation. Globally disabled plugins, missing assets or failed preparation can also make the list empty; read the diagnostics first and do not use a paid prompt as an initialization step.

## Local plugin

```text
example-plugin/
  .zcode-plugin/plugin.json
  skills/greet/SKILL.md
  commands/hello.md
```

Manifest example:

```json
{
  "name": "example-plugin",
  "version": "0.1.0",
  "description": "示例技能与命令",
  "skills": "skills",
  "commands": "commands"
}
```

(The sample description means "example skills and commands".) For skill and command content, see [Skills](08-skills.md). Enable the local directory in the runtime configuration:

```json
{
  "plugins": {
    "enabled": true,
    "dirs": ["/absolute/path/to/example-plugin"]
  }
}
```

Verify:

```sh
zcode plugins validate /absolute/path/to/example-plugin --json
zcode plugins list --json
zcode skills list --json
zcode commands list --json
```

A plugin can carry local executable content. Before installing, review its Hooks, MCP commands, dependencies and data access scope. validate only checks structure and diagnostics; it does not prove the plugin is safe or that all functions work. A field in a compatible manifest may not have a runtime implementation either; go by the load diagnostics.

## Data and reproducibility

The default directory is `~/.zcode/cli/plugins/`: the marketplace index, install records, the versioned content under `cache/` and the persistent data under `data/` are managed separately. The enabled state is also saved in the runtime configuration. Copying only the cache cannot fully restore the install and enabled state.

When a plugin needs persistent writes, use the plugin data directory and do not modify the plugin code directory. Before uninstalling, confirm whether to keep the data; batch experiments should pin versions and archive a non-sensitive listing. Do not auto-update marketplaces or plugins during comparison experiments.
