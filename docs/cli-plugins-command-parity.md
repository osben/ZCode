# CLI `zcode plugins` subcommands

> Status: phase 1 MR1 (subcommand surface). Phase 2 MR2 will add session-level plugin
> loading via `--plugin-dir`.

## Background and goal

External tooling automates plugin evaluation (built-in + the full zcode official
marketplace, real models) in Docker containers using headless mode. Evaluation
orchestration, task design, scoring, and credential injection stay outside the CLI;
the CLI core only guarantees "plugins can be installed into the image, selected per
run, and results read back in structured form". The stream-json event surface and
headless permission mode (default yolo) already suffice; this spec adds the
`zcode plugins` subcommand tree. The command surface is compatible with Claude
Code's `claude plugin`, so external evaluation scripts can switch the CLI binary and
keep working.

## Command surface

| Subcommand                                                                   | Behavior                                                                                                                           | Implementation                                                                              |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `list [--json] [--available]`                                                | List loaded plugins (built-in + installed); `--available` appends the marketplace catalog                                          | `listZCodePlugins` / `getZCodePluginsOverview`                                              |
| `install <plugin>[@marketplace] [-s <scope>]`                                | A bare name installs only if it matches uniquely across all marketplaces; multiple same-name hits error and require `@marketplace` | `installZCodeMarketplacePlugin`                                                             |
| `uninstall <plugin> [-s <scope>] [--keep-data] [--force]`                    | `--keep-data` removes only the install cache and keeps `data/<plugin-id>`; a non-TTY run without `--force` refuses                 | `uninstallZCodeMarketplacePlugin` (added `keepData`)                                        |
| `enable <plugin> [-s <scope>]` / `disable [plugin] [-a\|--all] [-s <scope>]` | `--all` disables each currently enabled plugin; `--all` cannot be combined with a plugin name or `--scope`                         | `setZCodePluginEnabled`                                                                     |
| `update <plugin> [-s <scope>]`                                               | Refreshes the owning marketplace catalog, then reinstalls the same entry; preserves installedAt and user switches                  | added `updateZCodeMarketplacePlugin`                                                        |
| `validate <path>`                                                            | Read-only validation of a local plugin directory / plugin.json / marketplace directory / marketplace.json                          | added `validateZCodePluginPath` → adapters `validateLocalPluginPath`                        |
| `marketplace add <source> [--scope] [--sparse <path>]`                       | `--sparse` is repeatable and applies only to git/github sources (reuses the existing `sparsePaths`)                                | `addZCodePluginMarketplace` (added `sparsePaths`)                                           |
| `marketplace list [--json]` / `remove <name>` / `update [name]`              | List, remove, refresh known marketplaces                                                                                           | `getZCodePluginsOverview` / `removeZCodePluginMarketplace` / `updateZCodePluginMarketplace` |
| alias `zcode plugin ...`                                                     | Singular alias, identical behavior to `zcode plugins`                                                                              | `run.ts`                                                                                    |

## JSON output contract

Fields reuse existing zcode naming:

- `list --json` outputs a **plain array** (no `{cwd, diagnostics, plugins}` wrapper);
  each entry carries a `diagnostics` array holding only diagnostics owned by that
  `pluginId`.
- `list --available --json` outputs `{ installed, available, diagnostics }`.
- `install` / `update` / `validate` / `marketplace update` JSON all carry `ok` and
  `diagnostics`; any `severity: "error"` diagnostic means `ok: false` and exit code 1.

## Parameter and behavior notes

| Item                                       | zcode behavior                                                                | Reason                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| scope values                               | `user` / `project` (project maps to internal `workspace`); `local` errors out | zcode has no local settings layer                            |
| `uninstall --force`                        | Non-interactive terminals refuse to uninstall without `--force`               | existing zcode safety valve, kept                            |
| `marketplace add --scope` / `uninstall -s` | Spelling is validated only; behavior is unchanged                             | known marketplaces / install records are Host User inventory |
| `marketplace add --sparse`                 | No varargs; repeat as `--sparse a --sparse b`                                 | the global parser is strict `parseArgs`                      |
| `list --json` entry fields                 | existing zcode fields + `diagnostics`                                         | do not break existing consumers                              |

## Implementation notes

- Subcommand flags (`--available`, `-s/--scope`, `-a/--all`, `--keep-data`,
  `--sparse`) are registered on the strict global parser in `run.ts`, collected into
  `PluginsCommandFlags`, and passed through without affecting other commands.
- `plugins-command.ts` maps CLI dependency names to bootstrap export names through
  the `BOOTSTRAP_EXPORTS` table: tests inject fakes by dependency name, production
  lazy-loads bootstrap by export name.
- `update` adds no adapter capability: `cacheMarketplacePlugin` overwrites an
  existing record in place and preserves `installedAt`;
  `enablePluginsByDefaultInFileConfig` only fills defaults for ids never explicitly
  declared, so updating never flips user switches.

## Typical evaluation usage

```bash
# Image build stage: install the full official marketplace
zcode plugins marketplace update
zcode plugins list --available --json | jq -r '.available[] | select(.installed==false) | .id' \
  | xargs -n1 zcode plugins install

# Per-task container: enable only the plugin under evaluation
zcode plugins disable --all
zcode plugins enable <plugin-id>
zcode --prompt "<task>" --output-format stream-json
```

## Verification

- Unit tests: `apps/zcode-cli/packages/cli/tests/plugins-command.test.ts` (subcommand
  routing, scope mapping, `--all` exclusivity, `--keep-data` pass-through, JSON
  shapes, `plugin` alias and flag collection).
- Known trap: the headless default model reads only `config.defaultModelSelection`
  from `~/.zcode/v2/provider_config.json` and requires `options.reasoningLevel`;
  otherwise it silently falls back to the first provider's first model.
