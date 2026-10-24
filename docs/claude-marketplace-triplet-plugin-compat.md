# Claude Marketplace triplet plugin compatibility spec

## Background

Following `docs/hooks-implementation-analysis.md`, this spec verifies Claude Code
marketplace plugins that bundle **skills, commands, and MCP servers** together, to
confirm that ZCode plugin discovery, installation, runtime projection, and the
downstream skill/command/MCP adapters are fully compatible.

Only low-risk resource projection is verified: no real MCP server starts, no
command executes, no hook runs.

## Samples

Samples come from the locally cached `claude-plugins-official` marketplace manifest:

```text
~/.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json
```

Selection: read a marketplace entry's GitHub `tree` and confirm the plugin root
contains all of `skills/*/SKILL.md`, `commands/*.md`, and `.mcp.json` or an MCP
config referenced by manifest `mcpServers`. The fixed 10 samples:

| Plugin                     | source shape               | skills | commands | MCP                      |
| -------------------------- | -------------------------- | -----: | -------: | ------------------------ |
| `appwrite`                 | repo root                  |     11 |        2 | `.mcp.json`              |
| `aws-agents-for-devsecops` | `git-subdir`               |     13 |        9 | `.mcp.json`              |
| `bigdata-com`              | `git-subdir`               |      1 |       27 | `.mcp.json`              |
| `cloudflare`               | repo root                  |     11 |        2 | `.mcp.json`              |
| `confidence`               | repo root                  |     11 |        5 | `.mcp.json`              |
| `convex`                   | repo root + manifest paths |      2 |        1 | `.mcp.json`              |
| `dominodatalab`            | repo root                  |     23 |        4 | `.mcp.json`              |
| `fiftyone`                 | repo root                  |     16 |        2 | `.mcp.json`              |
| `legalzoom`                | `git-subdir`               |      1 |        1 | `.mcp.json`              |
| `logfire`                  | `git-subdir`               |      3 |        4 | `.mcp.json` / `mcp.json` |

Backup samples: `mercadopago`, `nimble`, `notion`.

## Local test strategy

Offline adapter-layer fixture tests, no network, no real marketplace cache:

1. Build a marketplace manifest in a temp directory containing the 10 plugins.
2. Write each plugin's `.claude-plugin/plugin.json`, `skills/`, `commands/`, and
   `.mcp.json`.
3. Simulate marketplace install via `addMarketplace()` + `installMarketplacePlugin()`.
4. Enable all 10 via `createNodePluginAdapter().discoverPlugins()`.
5. Assert: all 10 plugins enabled; each has `skillRoots`, `commandRoots`,
   `mcpServers`; MCP server keys are namespaced as
   `plugin:<plugin-name>:<server-name>`.
6. Call the downstream adapters:
   `createNodeSkillAdapter().discoverSkills({ roots })` finds each plugin's skills;
   `createNodeCustomCommandAdapter().discoverCommands({ roots })` finds each
   plugin's commands.

## Compatibility criteria

Compatible:

- `.claude-plugin/plugin.json` is readable.
- Default `skills/` / `commands/` directories project onto runtime roots.
- Manifest path forms (for example `skills: "./skills/"`, `commands: "./commands/"`,
  `mcpServers: "./.mcp.json"`) project.
- `.mcp.json` is readable and convertible into a ZCode `McpServerConfig`.
- MCP env variables `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`,
  `${ZCODE_PROJECT_DIR}` are substituted.

Not compatible / needs separate diagnosis:

- A root `mcp.json` that the manifest does not reference through `mcpServers` is not
  read automatically by ZCode today.
- Whether a real MCP server can start is out of scope; only config projection is
  verified.

## skills field semantics

In the Claude plugin spec, array items of manifest `skills` point at the **skill
directory itself** (with `SKILL.md` directly inside, e.g. `./skills/engineering/tdd`);
the string form points at a **skill collection directory** (whose child directories
are each a skill). Both shapes are handled by the shared scan rules in
`apps/zcode-cli/packages/adapters/src/skills/scan.ts`:

- If a skill root itself contains `SKILL.md`, the root is one skill (array-item
  semantics, matching the desktop services side's depth-0 output of
  `skillDiscoveryWalk`);
- Otherwise scan one level of child directories (the string form / default
  `skills/` directory, ZCode's one-level layout); a child hit must verify that
  `SKILL.md` really exists, so category directories (like `skills/engineering/`)
  are not miscounted;
- If a declared root and a default root hit the same `SKILL.md`, deduplicate by
  file path so counts and discovery results do not double;
- When a manifest-declared skills path scans to 0 skills, emit a
  `plugin_skill_root_empty` warning diagnostic (the declared path goes into the
  message; the protocol wire schema carries no path field), shown in the plugin
  detail page's warnings area instead of staying silent. The message distinguishes
  `does not exist` (misconfigured manifest; only ENOENT/ENOTDIR count) from
  `does not contain any skills` (empty content, including links rejected by the
  security check leaving the scan empty).
- Trust boundary: plugin content is untrusted, so plugin-scope scanning **never
  follows symlinks** (including Windows junctions) — rejected at all three
  granularities: the root itself, child-directory candidates, and the `SKILL.md`
  file. Directory-level escapes (`skills/evil-link -> ../../outside`) and
  file-level escapes (`SKILL.md -> ~/.aws/credentials`) are blocked by the same
  standard; rejecting links is enough, no escape check depends on resolving link
  targets (no cross-drive `relative` predicate, no platform branches).
  Component enumeration (`collectSkillComponents`) applies the same rule to the
  plugin root unconditionally, regardless of whether the manifest parsed. The
  lexical defense (`resolveInside` rejecting absolute paths and `..` traversal)
  stays in force. User-level skill roots (symlink imports under `~/.zcode/skills`
  are a supported feature) keep following links by default, unchanged.

## Verification commands

```bash
pnpm --filter @zcode/adapters test plugins
pnpm typecheck
pnpm lint
```
