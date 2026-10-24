# Document official plugins

The former `document-skills` aggregate was split into four independent content plugins, plus a built-in `image-search` plugin, all enabled by default with the client:

| Plugin        | Skill | Source directory                                |
| ------------- | ----- | ----------------------------------------------- |
| documents     | docx  | `apps/zcode-cli/packages/documents-plugin`      |
| pdf           | pdf   | `apps/zcode-cli/packages/pdf-plugin`            |
| presentations | pptx  | `apps/zcode-cli/packages/presentations-plugin`  |
| spreadsheets  | xlsx  | `apps/zcode-cli/packages/spreadsheets-plugin`   |

Sync source: the internal plugin repo `zcode-marketplace/zcode-plugins-test`, `origin/main` commit `e19dca8be86cf981ed2e0c2b4855c6ee6ee15265`, directory `plugins/<plugin-name>`. The four built-in releases are all `0.1.8` (above the old aggregate's `0.1.5`). Imported directories are byte-aligned with upstream; only the built-in version fields in package.json and .zcode-plugin/plugin.json may differ. Content differences come from upstream exports; version fields bump along the built-in release sequence.

Licenses: all four document plugins and the image-search plugin are Apache-2.0 (since 2026-10-08; the document plugins were previously non-commercial and changed to Apache-2.0 with the open-sourcing, effective from 0.1.8; the upstream plugin repo must update its license too, or the next sync would bring the old license back).

Display names: Documents / Word文档, Presentations / 演示文档, PDF / PDF, Spreadsheets / 电子表格, Image Search / 搜图.

## Discovery, enabling, and upgrades

The Bootstrap official definition is the authority for built-in directories and default enablement; the Settings default list must match it. Startup → seed the four independent caches → rebuild the built-in marketplace shard → existing plugin discovery reads the shard → skills/agents are exposed. Caches live at `~/.zcode/cli/plugins/cache/zcode-plugins-official/<plugin-name>/0.1.8/`. Each plugin can be independently disabled, uninstalled, and restored; no built-in `document-skills` entry is published anymore. Old aggregate caches and user settings are not deleted; the rebuilt built-in shard no longer references the old directory. Market plugins the user installed separately keep their existing install/enable handling — nothing is auto-rewritten or uninstalled.

Each plugin ships `agents/visual-judge.md` under the qualified name `<plugin-name>:visual-judge`. The old `judge` name is no longer provided by built-in plugins. Each plugin carries only its own format skill; the four plugins no longer declare the `image_search` MCP — image search comes from the default-enabled `image-search` plugin, version `0.1.1`, accessing `${ZCODE_BASE_URL}/api/v1/mcp/server/image_search` with the existing official JWT auth; no new local MCP runtime. Its cache path is `~/.zcode/cli/plugins/cache/zcode-plugins-official/image-search/0.1.1/`.

## Packaging and acceptance

Filesystem seed, SEA, the Electron Node bundle, remote prebuild, server remote deployment, and container evaluation must all use the five directories, keeping `agents/`. Each release unit must verify its own `skills/<format>/SKILL.md` and `agents/visual-judge.md`; a missing required asset must never be marked as a complete cache. All version authorities (package, manifest, Bootstrap, SEA) and cache paths must agree; any content change requires a version bump.

Acceptance covers: all four plugins discovered by default and independently disable-able; the old aggregate entry no longer built in; the four format skills and qualified agent names each discoverable; filesystem/SEA integrity rejects a missing review agent; desktop and remote packaging manifests omit none of the plugins. This work changes only plugin content and distribution manifests — desktop continuous and mobile replayable session semantics are untouched.

## Dependency boundary

Built-in skills are not built-in system dependencies. LibreOffice, Poppler, Playwright, ReportLab, Tectonic, python-pptx, openpyxl, and friends come from the runtime environment or install via the upstream skill's environment checks. Script-relative paths resolve against the base directory the Skill tool returns.
