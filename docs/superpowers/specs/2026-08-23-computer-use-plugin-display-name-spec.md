# Computer Use Plugin Display Name Spec

## Background

The CUA plugin's historical manifest name is `zcode-cua`, while Browser Use's internal slug is `browser-use`.
The official catalog already sets CUA's display name to `Computer Use`, but installed plugins, capability
groups and some confirmation copy still formatted the old manifest name directly as `Zcode Cua`, making the
user-visible naming of the two official plugins inconsistent.

## Goals

- Every user-visible CUA plugin name uses `Computer Use`; Chinese uses `电脑控制`.
- User-visible contexts that need a slug use `computer-use` (for example the MCP server name); `zcode-cua` is
  no longer shown as a product name.
- The model-facing Skill canonical name is `computer-use`, with qualified name `computer-use:computer-use`;
  the producer and consumer Skill directories, sync scripts and provenance must keep the same name.
- The `@zcode/zcode-cua` package name, producer repository, producer pin, source paths and the macOS Helper
  bundle identity are unchanged; no compatibility alias for the old plugin ID or old Skill name is provided.

## Design

1. The official marketplace listing's `displayName`/`displayNameI18n` stays the authoritative source of the
   display name; the manifest does not duplicate display fields that could diverge from the catalog.
2. The settings page's installed plugin list, breadcrumbs, uninstall confirmation, and the
   Skills/Commands/Subagents/Hooks/MCP capability groups all resolve names through the same listing
   display-name logic; third-party plugins without a listing keep degrading to the original slug formatting.
3. The CUA repository changes only user-facing plugin titles, README/launcher log copy, and renames the
   model-facing Skill from `zcode-computer-use` to `computer-use`; the manifest `name: computer-use`,
   `mcpServers.computer-use`, the package name and runtime protocol fields are unchanged.

## Invariants

- Install, enable/disable, uninstall, update, permission broker injection and the MCP runtime namespace are
  still associated through `computer-use@zcode-plugins-official` and `plugin:computer-use:computer-use`.
- The official Skill found by SkillPort must be `computer-use:computer-use`; do not keep publishing
  `zcode-cua:zcode-computer-use`, and never expose two official Skills at once.
- A display-name change must not alter the desktop continuous or Web remote replayable runtime chain, nor the
  provenance/permission decisions of skills, commands and subagents.
- When the marketplace listing is missing or cannot be resolved, the UI safely falls back to the original
  canonical slug and never fabricates or hard-codes another plugin's name.

## Verification

- Unit tests cover zh/en display-name resolution of the CUA listing and the installed plugin list using the
  listing name.
- z-code runs `pnpm typecheck`, `pnpm lint` and the affected UI/plugin unit tests.
- CUA runs `pnpm typecheck`, `pnpm lint` and the affected script/copy contract tests.
