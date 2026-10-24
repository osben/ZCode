# Plugin creation entry and Plugin Creator

## Product contract

2026-09-16: the marketplace and the plugin-management User view share one “添加” (Add) menu with exactly two items, “创建插件” (create plugin) and “添加插件市场” (add plugin marketplace); no skill recording. The Workspace config view shows no marketplace write entry; the empty-state “浏览插件” keeps its current behavior.

Create plugin only opens a new-task draft, prefilled with the canonical reference to the `plugin-creator` Skill provided by the official `plugin-creator@zcode-plugins-official` plus one trailing space. Nothing is auto-sent, no model switch, no plugin install or enable. It uses the standard Root new-task orchestration and its draft persistence.

```text
click create -> resolve Root new-task target -> skillsService.list for that workspace
                                      |
                        validate target/attachment unchanged
                                      |
                  exact match official skill + enabled + valid path
                                      |
                  Root validates expectedWorkspaceKey -> startDraft
                                      |
                  initialPrompt + initialPromptMention -> Composer
```

Duplicate creation is disabled while a request is in flight; if the workspace identity, remote attachment, or service instance changes, or the entry unmounts, the old result is not committed. Missing/disabled skill, disconnection, or load failure shows a clear message and keeps the current task. Identity is `workspaceIdentity?.trim() || workspacePath`; the path always comes from the target host; mobile uses only visible workspaces, desktop keeps the focused pane. No changes to continuous/replayable, runtime, or the accepted queue.

Add plugin marketplace reuses the existing store dialog and store mutation. The management page opens the marketplace and dialog via optional navigation `intent: "add-marketplace"`; success switches to the personal section, failure keeps input and error.

## Plugin search

The marketplace and management pages share the matching rules: text search over the current-language name/description, original name, full ID, and marketplace name; the original name and every display name in the listing support toneless pinyin full and initial substring matching, ignoring case and spaces inside the pinyin. The English UI can also find the Chinese name “飞书” via `feishu`, `fei shu`, or `fs`. Same-name cross-market plugins keep full-ID linkage; no alias tables, typo tolerance, or sort changes; the chat-input skill search is unchanged.

## Skill content and distribution

`plugin-creator` is a standalone built-in content plugin, version 0.1.1, enabled by default, Chinese name “插件创建器”. It ships with Desktop, CLI/SEA, and server/remote Agent assets; all scripts/references must exist.

The skill is organized as scaffold → optional components → validate → install/update, with the body routing to scripts and reference material. Scaffolding uses the Node standard library with async IO, defaults to `<cwd>/plugins/<slug>`, normalizes names to lowercase hyphens, and keeps directory names consistent with the manifest. Existing files are not overwritten by default; explicit force updates only the selected files; marketplace-unrelated fields and entry order are preserved. Components declare only paths they actually generate.

It generates the ZCode `.zcode-plugin/plugin.json`; the marketplace listing carries display names and i18n. 2026-09-17 convergence: the default deliverable is source code, a test-marketplace manifest, and manual add/install/update/try instructions; the user performs the marketplace and install actions in the UI. Ordinary desktop users do not need the CLI or Node; with an existing dev runtime the helper scripts may be used, and without a runtime the skill uses file tools to prepare source and JSON. It checks structure, resource paths, and placeholders; `zcode plugins validate` runs only when a usable dev CLI already exists — without running it, the skill must not claim protocol validation passed.

## Local dev marketplace loop

The current deliverable is: source implementation → runnable checks and capability smoke → dev manifest → the user manually adds the marketplace, installs/updates, and tries the result in a new task. Sending only the skill reference still requires stating the purpose first; when the user explicitly wants only source, no marketplace is generated. The skill never registers, installs, updates, or enables plugins itself, never requires the user to run CLI commands, and adds no new internal tools or runtime entry points.

- Source stays at `plugins/<slug>/` in the current workspace by default. The dev manifest defaults to the sibling `plugins/marketplace.json`; an explicit directory/marketplace choice wins.
- With Node available, the existing helper may be used; the marketplace name is `dev-<parent-workspace-name>-<first 8 hex of the SHA256 of the normalized marketplace root>`. Without Node, generate the manifest with file tools per the reference spec, choose an explicit `dev-`-prefixed name, store it in the manifest, and reuse it for later updates. An existing manifest is reused first; if the helper is adopted later, pass that marketplace file explicitly. A same-name different-source conflict is reported, never implicitly taken over or removed.
- The manifest updates only its own listing and never regenerates plugin source; it syncs manifest name, version, and description, provides an accurate display name and Chinese metadata, and preserves unrelated entries, fields, and order. The existing helper's atomic writes, locking, and path protection are unchanged.
- Manual add path: `插件市场 → 添加 → 添加插件市场`, paste the absolute path of the marketplace root (the workspace's `plugins/` by default, not a single plugin subdirectory), click add; after success find the actual marketplace name and the plugin in the `个人` section, then click install.
- Marketplace actions run through the existing UI and plugin services; the registry and install records stay the Host user-level inventory. Mobile/remote uses paths on the target Host, not unrelated directories on the phone or the current machine. Internal known/installed/cache files are never edited.
- To modify an existing plugin: bump the semantic version and sync the listing first, then guide the user to the marketplace page gear → `市场源` (marketplace sources), click `刷新该市场` (refresh that marketplace) for the matching market, open the plugin detail and click `更新` (update), then try it in a new task. Existing explicit-disable choices are preserved; the installed copy is not the source, and hot reload is not claimed.
- The final reply lists the absolute paths of the source, marketplace root, and manifest, the actual marketplace name/full pluginId/source version, the manual steps, and expected results. Before the actions run, it explicitly states that the marketplace is pending manual add, the plugin pending install, and the trial pending verification; an existing install not re-verified in the current round is marked unverified.
- New-task trial hints use only discoverable plugin/skill selection; when not installed, no install paths or installed skill references are invented. A failed add keeps the source and asks for the UI error to continue; a cancel or absent user feedback is not completion.

```text
source directory (user-maintained)
  → manifest / capability checks
  → dev marketplace.json (file tools or an available helper)
  → deliver exact paths and action instructions
  → user adds/refreshes the marketplace in the UI → installs/updates the plugin
  → verify in personal marketplace/management → user tries it in a new task
```

Acceptance of the current instructions: with no global CLI/Node the skill can still deliver source, manifest, and UI steps; the first-add and existing-plugin-update paths are clear; cancel/failure/not-yet-tried keep truthful state. The existing isolated CLI integration tests prove only the helper scripts and install mechanism, not that an ordinary user has completed the manual flow. No new UI/backend protocol.

## Acceptance and impact

| Case | State/action | Asserts |
| --- | --- | --- |
| PLM-LC-018 | zh/en management list and search | Full-ID listing linkage; name/description/feedback consistent; original and Chinese names searchable; missing translations fall back to the original |
| PLM-LC-019 | Both add menus/create | Two menu items; real skill chip and trailing space; not sent; remount restores the same draft |
| PLM-LC-020 | Add source success/failure/cancel | Navigation consumed once; success goes to the personal section; failure keeps input; cancel writes nothing |
| creator-boundary | Duplicate clicks, identity/attachment switches, disabled/missing | Only the current target commits once; errors cause no prefill/enable side effects |
| creator-assets | Node/SEA/Desktop/remote | manifest, skill, scripts, references all present and discoverable |
| creator-scaffold | Minimal, skill, MCP, hook, marketplace, update | ZCode validation passes; invalid input, out-of-scope, duplicate/overwrite, TODO rejected |
| creator-dev-market | Create/update dev listing, same-name workspaces, write races | Stable ID; unrelated data and source preserved; source conflicts, duplicates, out-of-scope, lock contention rejected; exclusive temp-file failure does not delete existing files |
| creator-dev-workflow | Real CLI create, register, install, version update | available/installed IDs and versions match; install directory separate from source; content updates take effect with explicit disables preserved |
| creator-manual-handoff | No CLI/Node, first add, existing-plugin update, cancel/failure | Real directories and UI steps given; no auto register/install; no invented install references; incomplete states explicit |

UI/draft owners: management and store components own display/entry, Root owns the new task, the Composer draft store owns the prefill facts; skill/plugin content is decided by target-host discovery. The shared menu, prefill builder, and both searches are must-inspect; the runtime is invariant-only. Codegraph was used to locate old-workspace files; the implementation workspace has no index — read the located files for current source. The architecture gate's ui/zcode-cli is currently unmanaged; passing the gate does not replace semantic review.

The corresponding E2E lives in `plugins/manual-review/pending` and needs manual review before promotion; desktop wide-screen zh light and narrow-screen en dark cover display; remote-control identity is covered by targeted unit tests — without a real phone/SSH run it must be listed as pending verification.

Known environment trap: when starting the MR helper locally via uv, ensure its child process PATH prefers Node 24.14.0 so Homebrew Node 26 does not override the repo runtime.

## Plugin Creator icon

The official `plugin-creator@zcode-plugins-official` uses the local `packages/ui/src/assets/plugin-icons/plugin-creator.png` on store cards, installed rows, details, and the management list: a blue gradient rounded block with a white plus, transparent background, matching the existing document plugin icon style. Old images in the cache are overridden by this official identity's local icon; same-name plugins from other marketplaces keep their own listing icons.
