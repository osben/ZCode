# Plugin Marketplace Browse Redesign + On-Demand Component Details

> Historical worklog (2026-06-26), kept for the `plugins/describe` decision and open follow-ups.
> Spec: `docs/plugin-marketplace-ui-ux.md` (2026-06-25 revision section). Implementation:
> `packages/shared/src/zcode-protocol/index.ts`, `apps/zcode-cli/packages/adapters/src/plugins/`,
> `packages/ui/src/settings/PluginMarketplaceManagement.tsx`.

## Outcome

The Marketplace browse tab is a left marketplace switcher + right plugin card grid with a
list↔detail toggle. The detail view shows each component's name + description
(Skills / Subagents / Commands / Hooks / MCPs) even for uninstalled plugins.

The marketplace protocol (`ZCodeAvailablePluginSummary`) only carries a coarse
`componentTypes` array; real `marketplace.json` entries hold a pointer
(`"source": "./plugins/<name>"`), so per-component names/descriptions require reading the
plugin directory. That is why the only protocol change of this work was an on-demand RPC:

- `plugins/describe` (`zcodeProtocolMethods.pluginsDescribe`), params
  `{ workspace, marketplace, pluginName }`, result
  `{ components: Array<{ kind: agent|command|skill|hook|mcp, items: Array<{ name, description? }> }>, diagnostics? }`.
- CLI handler `describeMarketplacePlugin`: installed plugins resolve from the local cache
  (`resolveInstalledPluginRoot`, offline); uninstalled plugins resolve from a temp clone
  (`mkdtemp`, cleaned up in `finally`), mirroring `validateMarketplacePlugin`.
  Component enumeration lives in `adapters/src/plugins/plugin-components.ts` (frontmatter of
  `commands/`, `agents/`, `skills/SKILL.md`, manifest hook events and MCP server names).
- UI: `PluginMarketplaceManagement.tsx` (switcher degrades to horizontal chips on narrow
  widths); `PluginComponentGroups.tsx` is the shared "name — description" renderer also used by
  the installed-plugin dialog; `describeCache` in `pluginManagementStore.ts` is keyed by
  pluginId (loading/loaded/error; `force` retries; cache hits skip refetch). Describe
  loading/error/empty all degrade gracefully to `componentTypes` badges + retry.

Out of scope: a left category nav (protocol has no `category` field); install/uninstall and
marketplace CRUD were untouched.

## Open Follow-Ups / Risks

- Cross-platform: describe uses only `node:path` / `node:fs` / `mkdtemp(tmpdir())`, but
  git-clone-on-describe for uninstalled plugins was only exercised on macOS; Windows/Linux
  still needs a pass.
- Network cost: describing an uninstalled plugin clones its source to a temp dir each cold
  open; consider a CLI-side short-lived cache if this bites.
- Frontmatter parsing in `plugin-components.ts` duplicates the skills/commands adapter idiom;
  extract a shared util if a third consumer appears.
- Category nav stays deferred pending a protocol `category` field.
