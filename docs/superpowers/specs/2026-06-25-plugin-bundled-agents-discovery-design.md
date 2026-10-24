# Plugin-Bundled Agents Discovery Design

## Runtime naming and UI resource projection boundary (2026-07-18)

Enabled plugin agents enter the runtime list. One plugin agent file maps to one canonical resource named `<plugin-name>:<agent-name>`; the runtime also offers the bare `<agent-name>` compat alias when the bare name is unique across built-in, user, workspace, and other plugins.

Both names are invocation entries for the same file, not two installed resources, so the list contract distinguishes:

- `AgentsListResult.agents` is the runtime invocation projection and may contain both canonical names and unique bare-name aliases.
- `AgentsListResult.pluginAgents` is the plugin resource projection: exactly one canonical-name entry per agent file.
- Settings > Subagents must render plugin resources from `pluginAgents` and never treat runtime aliases in `agents` as additional plugin rows (this fixes "install one plugin agent, settings shows two").
- Plugin detail continues attributing by real `path` via `pluginAgents`.

This boundary supersedes the original design's historical constraints ("not entering the runtime" and "`agents` semantics unchanged").

## Official cache and plugin overrides continuation (2026-09-09, Todo103)

- Add discovery of official cache entries without install records, honoring: install records first, explicit disable/uninstall suppression first, valid-manifest version selection.
- Default-enabled IDs moved to the shared marketplace contract; Node-only directory scanning moved to the shared Node entry. The original "copy a third instance" approach below is historical — do not add new cross-domain implementation dependencies based on it.
- Plugin agents may carry user model/reasoning overrides keyed by stable ID; canonical and bare names load the same override and never rewrite plugin files. Storage, offline migration, cold start, and effective-selection semantics follow G04-B in `docs/subagents-built-in-model-overrides.md`.

## Background

Installed plugin packages (`<storageRoot>/cache/<marketplace>/<plugin>/<version>/`) can contain sibling `commands/`, `hooks/`, `skills/`, `agents/` directories. Commit `41bb6b7af` (`fix(plugins): include installed marketplace resources`) made `skillsService` and `commandsService` scan installed packages' `skills/`/`commands/` in place, grouped by plugin in the management UI. But `agents/` was scanned by nothing: `subagentsService.list()`'s `AgentsListResult.pluginAgents` was hardcoded `[]` (`subagentsService.ts:338`), leaving the plugin "Agents" group permanently empty. Goal: scan installed packages' `agents/`, fill the canonical `pluginAgents` projection, and generate conflict-free runtime invocation names.

Scope (user-aligned): discovery + plugin management UI display + canonical-name/unique-bare-name runtime projection. Not done: no physical copies into `~/.zcode/agents` — in-place scanning means uninstall removes everything, with no stale-copy or rename problems.

Architecture facts (from exploration):

- UI already ready: `PluginsSection.tsx:114` reads `agentsResult.value.pluginAgents`; `pluginManagedResourceGroups.ts:74-78` attributes agents to a plugin by `agent.source === "plugin"` and `agent.path` under `plugin.rootPath`; `InstalledPluginManagement.tsx:46,54` has the "agent" group styling and i18n key (`settings.plugins.detail.component.agent` = "Agents", zh/en).
- Contract already ready: `AgentSummary.source` is `"user" | "plugin"` (`packages/shared/src/subagents-types.ts:3`) and `AgentsListResult.pluginAgents` exists (`:28`).
- Sole gap: nobody scans plugin `agents/` directories.
- Project style is "copy per service": `skillsService` and `commandsService` each duplicate the same plugin discovery helpers (`PluginRootCandidate`, `readPluginConfigFromConfig`, `resolvePluginStorageRoot`, `scanOfficialPluginCacheRoots`, `readPluginManifest`/`findPluginManifestPath`, `parsePathList`, `resolveInside`, `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`, `ZCODE_*_MARKETPLACE` constants); only `readInstalledPluginRoots` (`packages/services/src/plugins/installedPluginRoots.ts`) is shared. Agents follow suit in `subagentsService.ts` with the component directory `agents`.
- `subagentsService.ts` already has parsing primitives: `collectAgentMarkdownPaths(rootPath)` (layouts `<name>.md`, `<name>/agent.md`, `<name>/index.md`) and `readAgentFrontmatter(content)` (name/description/color/model/tools/systemPrompt; CRLF- and Chinese-colon-tolerant).

Design (one source file + tests):

1. `packages/services/src/subagents/subagentsService.ts`:
   - Copy the plugin discovery helpers aligned with `skillsService.ts` / `commandsService.ts`: `readCliConfigFile()` / `readPluginConfigFromConfig(config)` (plugin `enabled`, `dirs`, `storageDir`, `enabledPlugins`), `resolvePluginStorageRoot(storageDir)` / `resolveConfigPath(path)`, `scanOfficialPluginCacheRoots(pluginStorageRoot)` (`<plugin>/<version>` under official marketplace caches), `readPluginManifest(rootPath)` / `findPluginManifestPath(rootPath)` (`.zcode-plugin`, `.claude-plugin`, `.codex-plugin` manifests, same priority fallback; reads `name` and `agents`), `parsePathList(value)` / `resolveInside(rootPath, rawPath)` (manifest `agents` → path list; absolute or `..` escapes return `null`), the ID/marketplace constants, plus the shared `readInstalledPluginRoots`. Local `PluginManifestSummary` shape: `{ name: string; agents?: unknown }`. The helpers already exist twice for skills/commands; this third copy follows the established style without an incidental shared-module refactor.
   - `resolvePluginAgentRoots({ manifest, rootPath })` (aligned with `resolvePluginSkillRoots`): resolve `manifest.agents` through `parsePathList` + `resolveInside`; when `manifest.agents === undefined`, fall back to `<rootPath>/agents` if present (like skills' `<rootPath>/skills`).
   - `discoverPluginAgents()` (aligned with `resolvePluginSkillRootDescriptors`):
     1. Read plugin config; `enabled === false` → `[]`.
     2. Candidate roots: inline (`config.dirs`) + official cache (`scanOfficialPluginCacheRoots`) + installed (`readInstalledPluginRoots`).
     3. Read each manifest, dedupe by `<name>@<marketplace>`; enablement via `config.enabledPlugins[pluginId] ?? (defaultEnabled || DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(pluginId))`; skip disabled.
     4. For each enabled plugin's agent roots, parse via `collectAgentMarkdownPaths` + `readAgentFrontmatter` into `AgentSummary`: `source: "plugin"`, `scope: "user"`, `path` = the real absolute path under the plugin root (the UI attributes by it), `id` = `plugin:<plugin>:<agent>` (distinct from user `user:<name>`, no id collisions), frontmatter fields, `enabled: true`.
     5. Individual read failures drop that agent only (user-agent tolerance).
   - `list()`: call `discoverPluginAgents()` after `discoverUserAgents(...)`. Canonical names always enter `agents` and `pluginAgents`; bare names enter `agents` only without conflicts. `pluginAgents` returns one canonical entry per file, never runtime bare-name aliases. User, workspace, and built-in agents claim bare names first; on conflict keep the plugin canonical name and emit a diagnostic. Settings > Subagents merges non-plugin `agents` with canonical `pluginAgents` so aliases don't render twice.
2. `packages/services/test/subagentsService.test.ts` (fixture style per `skillsService.test.ts`: temp HOME, `installed_plugins.json`, `.zcode-plugin/plugin.json` or `.claude-plugin/plugin.json`):
   - Installed plugin with `agents/foo.md` → `pluginAgents` contains it with `source === "plugin"`, correct `path`, frontmatter-derived fields.
   - Projection separation: `agents` contains canonical and unique bare names; `pluginAgents` contains exactly one canonical entry for the same file.
   - No settings duplication with both projections present.
   - `enabledPlugins: false` yields no agents.
   - Manifest `"agents": "custom-agents"` scans `custom-agents/` instead of `agents/`.
   - Same-name user agent wins (`source === "user"`), plugin copy skipped.
   - Default-directory fallback without a declared `agents` field.

Error handling: missing config / `installed_plugins.json` → existing try/catch fallbacks return empty, never throw; a failing agent markdown is skipped without affecting others; `resolveInside` `null` discards escaping paths.

Not done (YAGNI): no agent file format or subagent protocol changes; no i18n or `AgentSummary`/`AgentsListResult` contract extensions; no physical copying to `~/.zcode/agents`; no shared plugin-discovery module (keep the per-service copy style).

Verification: `npm run lint` and `npm test` (at least the packages/services subagents tests).
