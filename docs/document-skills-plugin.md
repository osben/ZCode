# Document official plugins

The former `document-skills` aggregate was split into four independent content plugins, plus a built-in `image-search` plugin, all enabled by default with the client:

| Plugin        | Skill | Source directory                               |
| ------------- | ----- | ---------------------------------------------- |
| documents     | docx  | `apps/zcode-cli/packages/documents-plugin`     |
| pdf           | pdf   | `apps/zcode-cli/packages/pdf-plugin`           |
| presentations | pptx  | `apps/zcode-cli/packages/presentations-plugin` |
| spreadsheets  | xlsx  | `apps/zcode-cli/packages/spreadsheets-plugin`  |

## Source

Since 2026-10-29 this repository is the single source of truth for the four document plugins: plugin changes are made directly here and bump the version by the version rules, instead of changing the main plugin repository first and importing afterwards.

Earlier production content came from the main plugin repository, and the last LibreOffice increment was imported from local upstream commit `583d3759112d8350d93f58cb4848600da590d6b5` (TREE `970a9044e75d27355913f5cf01b1a43b8cfc70b6`). The source and the 63 per-file records are in [08-source-import.json](issues/document-tool-preinstall/08-source-import.json), kept as history only.

Viewer artifacts are still built by this repository's [office-runtime](../apps/zcode-cli/packages/office-runtime/CONTRACT.md) and follow the [built-in viewer panel spec](plugins/2026-10-15-office-viewer-builtin-panels-spec.md).

Unmanaged environments keep the existing program discovery and install semantics; system programs have no minimum version gate.

Current versions: documents, presentations and spreadsheets are `0.2.10`, pdf is `0.2.11`. From this version on the visual acceptance subagent is no longer provided (see below), so the content differs from the earlier `0.2.9` and `0.2.10` and the version is bumped once more; the new version uses a new cache directory, so upgraded users no longer load the subagent from the old cache. System programs keep the symbolic-link invocation name so that multi-entry dispatch does not break.

Licenses: all four document plugins and the image-search plugin are Apache-2.0. This change keeps the existing license files, imports no differently licensed text from the old upstream and changes no license grant.

Display names: Documents / Word文档, Presentations / 演示文档, PDF / PDF, Spreadsheets / 电子表格, Image Search / 搜图.

## Discovery, enabling, and upgrades

The Bootstrap official definition is the authority for built-in directories and default enablement; the Settings default list must match it. Startup → seed the four independent caches → rebuild the built-in marketplace shard → existing plugin discovery reads the shard → skills and viewer panels are exposed. Caches live at `~/.zcode/cli/plugins/cache/zcode-plugins-official/<plugin-name>/<plugin version>/`; the version is the one that package/manifest and Bootstrap declare consistently. Each plugin can be independently disabled, uninstalled, and restored; no built-in `document-skills` entry is published anymore. Old aggregate caches and user settings are not deleted; the rebuilt built-in shard no longer references the old directory. Market plugins the user installed separately keep their existing install/enable handling, and nothing is auto-rewritten or uninstalled.

The four plugins ship no subagent: since documents/presentations/spreadsheets `0.2.10` and pdf `0.2.11`, `agents/visual-judge.md` is deleted, the manifest no longer declares `agents`, and `<plugin-name>:visual-judge` no longer appears in the Settings subagent list. When generating documents no subagent does visual acceptance; when a visual check is needed, the Agent renders the output to images and looks at them itself once, without calling an external VLM. There is no separate switch for plugin subagents.
The old `judge` name is likewise no longer provided. Each plugin carries only its own format skill; the four plugins no longer declare the `image_search` MCP, image search comes from the default-enabled `image-search` plugin, version `0.1.1`, accessing `${ZCODE_BASE_URL}/api/v1/mcp/server/image_search` with the existing official JWT auth; no new local MCP runtime is added.
The `image-search` cache path is `~/.zcode/cli/plugins/cache/zcode-plugins-official/image-search/0.1.1/`.

## Packaging and acceptance

Filesystem seed, SEA, the Electron Node bundle, remote prebuild, server remote deployment, and container evaluation must all use the five directories. The four document plugins must also keep `scripts/zcode_libreoffice.py` and the complete `scripts/libreoffice-profile/`; the four copies must be byte-identical, which an engineering gate checks. Each release unit must verify its own `skills/<format>/SKILL.md` and `skills/<format>-viewer/SKILL.md`; a missing required asset must never be marked as a complete cache. The four document plugins no longer carry `agents/` and no longer list subagent files as required assets. All version authorities (package, manifest, Bootstrap, SEA) and cache paths must agree; any content change requires a version bump.

Acceptance covers: all four plugins discovered by default and independently disable-able; the old aggregate entry no longer built in; the four format skills each discoverable; the Settings subagent list shows none of the four `<plugin-name>:visual-judge`; filesystem/SEA integrity rejects a missing skill or panel asset; desktop and remote packaging manifests omit none of the plugins. This work changes only plugin content and distribution manifests, and desktop continuous and mobile replayable session semantics are untouched.

Each content change is published as a new version cache; the Bootstrap definition, package and plugin manifest are bumped together. The 0.1.8 above is the import record of the initial split; later versions follow the definition and each plugin manifest.

## Dependency boundary

Built-in Skills and viewer panels being available does not mean the environment for document conversion and recalculation is ready.

The contract since 2026-10-29 is in [preinstalled tools](preinstalled-tools/README.md); what follows is the plugin-side summary. The preinstall chain and the plugin calls are implemented; the resource release of the official catalog and part of the platform acceptance are not finished, so a complete preinstalled environment has not been delivered to users yet.

The local desktop preinstalls five tools: Python (with the packages the plugins' main flows use), qpdf, Pandoc, Poppler and LibreOffice. The plugins do not replace the tools and libraries they depend on; they only change where to look for the tools and the guidance when one is missing:

| Tool                  | How the plugin calls it                                                                                                                                                                         | When not ready or the switch is off                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Poppler, Pandoc, qpdf | The original command name, for example `pdftoppm`. The preinstalled entry sits first in the Agent PATH                                                                                          | Finds the program the user installed                |
| Python                | Look for `zcode-python` first, then fall back to `python3`; running scripts and installing packages are both written this way, see the [Python spec](preinstalled-tools/python.md#插件调用规则) | Falls back to the user's `python3`                  |
| LibreOffice           | One entry, `scripts/zcode_libreoffice.py`, which looks for `zcode-soffice` first                                                                                                                | Uses the system version (any version, Dev included) |

- Packages installed under the preinstalled Python go to its additional area and leave the preinstalled packages untouched. When the install fails or the preinstalled Python cannot run, the Agent first explains the reason, and the user then chooses whether to use their own Python.
- When the preinstalled LibreOffice fails to start or run, the entry cleans up first and then reruns once with the system version; a system failure is reported directly, and a cancel is not rerun. Each call uses its own profile; recalculation uses this call's macro receipt; the user's default configuration is not modified.
- When none of the tools is available (same for all five): a desktop with `ZCODE_PREINSTALLED_TOOLS_AVAILABLE` first says the preinstalled version is not ready or has been turned off and points to "Help → Preinstalled tools", and the user chooses to wait, turn the switch on, or continue the plugin's original way (for example install per setup.md); other environments keep the original install guidance.
- Not preinstalled: Node.js and npm packages, tectonic, Chromium, Ghostscript, tesseract, pytesseract, markitdown, adjustText and PyMuPDF. They are still handled by the plugins' existing environment checks and install notes.
- Web server, standalone CLI, containers and remote environments have no entry directory or variable and behave as they do now. Preinstall is local only and is not deployed to SSH, WSL, Docker or other remote workspaces.

Script-relative paths resolve against the base directory the Skill tool returns. The four format Skills live in `skills/<format>/`, and the shared entry locates itself from there as `../../scripts/zcode_libreoffice.py`; the configuration template is in `libreoffice-profile/` under the same script directory.
