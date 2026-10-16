# System prompt section overrides

Status: phase 1 (constants + runtime + storage + service) is implemented. Phase 2 (Settings UI)
is specified below.

## Problem

The main agent's system prompt is assembled from sections whose text is hardcoded in
`apps/zcode-cli/packages/core/src/context/` (see the trajectory view: CLI prefix, identity +
`# Harness`, `# Communicating with the user`, `# Context management`, `# Memory`). Users can
see these blocks but cannot change them. Output Styles (docs/output-styles-settings.md)
introduced the override mechanism for tone; this extends the same mechanism to the prompt
sections themselves.

## Mechanism (same contract as output styles)

- Default text stays **code constants**, now in `packages/shared/src/system-prompt.ts`
  (`SYSTEM_PROMPT_DEFAULTS`), so the settings UI, the CLI, and the desktop service all read
  one source. Core section builders import from shared; rendered defaults are byte-identical
  (pinned by the existing system-prompt contract tests).
- An override file at `~/.zcode/system-prompt/<key>.md` replaces the default for that key;
  deleting the file restores the constant. Empty (whitespace-only) files are ignored.
- The bootstrap loader reads overrides at session start and passes them via
  `AgentRuntimeConfig.systemPromptOverrides` (same `persisted*` pattern as the output style);
  explicit `runtimeConfig.systemPromptOverrides` wins over disk.

## Editable keys and boundaries

| Key                  | Replaces                                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli-prefix`         | `You are ZCode, an interactive coding agent`                                           |                                                                                                                                                                                                                                                                                                                                                                               |
| `identity-intro`     | identity opening sentence                                                              | Beats an active Output Style intro; the Output Style still appends its `# Output Style` section                                                                                                                                                                                                                                                                               |
| `harness`            | the `# Harness` block                                                                  | Applies to the main agent; the workflow-actor identity keeps the constant (subagent contract)                                                                                                                                                                                                                                                                                 |
| `communication`      | the whole `# Communicating with the user` section incl. code-style and risk paragraphs |                                                                                                                                                                                                                                                                                                                                                                               |
| `context-management` | the whole `# Context management` section incl. autonomy appendix                       |                                                                                                                                                                                                                                                                                                                                                                               |
| `memory-guidance`    | the `# Memory` guidance body                                                           | Supports one placeholder, `{{memoryRoot}}`, substituted with the session memory root; override replaces the whole body incl. the retrieval-branch line. The default the service reports is the active-branch rendering (`composeMemoryGuidanceDefault("default-index")`), which includes the `MEMORY.md` index pointer paragraph — byte-identical to what the runtime renders |

**Not editable:** the authorized-security notice (product safety constant), `# ZCode Desktop
Context`, `# Session-specific guidance`, `# Environment`, `gitStatus` (runtime-computed), and
all subagent/workflow prompt fragments — including the subagent context builder's CLI prefix
and the workflow-actor `# Harness`, which keep the code defaults. These are shown read-only
or omitted in the UI.

## Storage

| Path                              | Owner                             | Content             |
| --------------------------------- | --------------------------------- | ------------------- |
| `~/.zcode/system-prompt/<key>.md` | service (write), bootstrap (read) | plain override body |

Keys are a fixed whitelist; filenames derive from that whitelist only (no user-derived
filename, no sanitization surface).

The location is fixed at `$HOME/.zcode/system-prompt` regardless of `config.storage.dir`
(`ZCODE_STORAGE_DIR`, project/user `storage.dir`, beta default) — the same rule as the global
`~/.zcode/AGENTS.md` lookup. The host service cannot see the CLI's resolved storage config, so
a fixed home-based path is what keeps the service's writes and the bootstrap loader's reads on
the same directory.

## Settings UI (phase 2)

Keep "Output Styles" as its own existing entry and add a separate "System Prompts" entry to
Settings' Agent Capabilities group. Do not add tabs between these editors. The System Prompts
page is a desktop Settings surface, like the existing Output Styles editor. Web shows a
localized unsupported-host state because its Home-only service does not provide
filesystem-backed system-prompt overrides. The UI must use the existing
`ISystemPromptService`; no new service, protocol field, or runtime write path is introduced.

The section lists exactly the six keys in `SYSTEM_PROMPT_OVERRIDE_KEYS`, ordered by their
appearance in `ContextBuilder.build()`: `cli-prefix`, `identity-intro`, `harness`,
`communication`, `memory-guidance`, `context-management`. Each entry shows its localized
section name, one effective-text preview, a "Customized" state when an override file is
effective, and an Edit action. Editing opens exactly one text editor for that section (the row
preview is hidden until the editor closes), a diff preview while editing, and "Restore default"
when customized. The editor opens with the current effective text and shows a live Unicode
grapheme character count for its draft; the count is informational and is not a limit.
Saving writes the override through the service and reloads the section. Restoring asks for
confirmation with a warning that the override for that section on the displayed host will be
deleted; declining leaves it untouched, and confirming deletes it through the service and
reloads the section. Empty or whitespace-only drafts cannot be saved as customizations because
the service treats whitespace-only files as absent. While a draft is dirty, opening another
section editor and restoring any section are disabled until the draft is saved or discarded.
The read-only preview shows the effective text for editable sections only. Protected sections
remain omitted; the editor must not expose a write path for any key outside the whitelist.

The editor targets the active workspace host: the local service for local workspaces and the
remote service resolved for a remote workspace. The service instance is part of the editor's
target snapshot and is used for reads and writes. On remote disconnect, editing and saving are
unavailable until the remote RPC is ready; an already loaded draft stays bound to that host.
When the active host changes while a draft is dirty, ask whether to discard it. Declining keeps
the editor pinned to its original host and preserves the draft; confirming discards the draft
and binds to the newly active host. A reconnect to the same remote identity updates connection
metadata without changing the editor host. Settings navigation and window-close guards also
protect a dirty draft.

New sessions are affected after a successful save; an existing session keeps its startup
prompt. The section does not change the runtime or push prompt updates into running sessions.

### Special effective defaults

- With no override, `identity-intro` uses the runtime's Output Style intro when an Output Style
  is active; otherwise it uses `DEFAULT_IDENTITY_INTRO_PROMPT`. Show that effective baseline
  in the editor and diff. An explicit `identity-intro` override wins over the Output Style
  intro, while the Output Style section continues to append. Keep the runtime intro sentence
  in a shared constant so the Settings baseline and CLI rendering cannot drift.
- Keep `{{memoryRoot}}` literal in the `memory-guidance` editor and preview. Explain that the
  runtime substitutes the current session's memory root when a new session starts. Do not
  resolve or replace the placeholder in Settings.
- Show variable guidance next to the section that uses it. `memory-guidance` supports only
  `{{memoryRoot}}`, the path to the current session's memory directory. The other five
  editable sections have no runtime variables and should not imply otherwise.
- Do not allow opening the `identity-intro` editor until Output Styles has resolved whether a
  style is active. This prevents a slow Output Styles load from capturing the plain default as
  the baseline when the runtime will use the Output Style intro.
- The editor set is limited to the six keys above. The security notice, Desktop Context,
  session-specific guidance, Environment, `gitStatus`, and all subagent/workflow fragments
  remain read-only or omitted as described in "Not editable".

### Acceptance criteria

- Settings exposes exactly the six whitelisted sections in the defined order and no protected
  prompt fragment can be edited.
- Each section displays its effective default or override, reports customization accurately,
  previews draft differences, saves overrides, and restores defaults by deleting files.
- A dirty draft cannot be silently replaced by opening another section editor or restoring a
  section; those actions stay unavailable until the draft is saved or discarded.
- Settings has separate Output Styles and System Prompts navigation entries; neither editor is
  nested in a tab of the other. Leaving the System Prompts page preserves its dirty-draft guard.
- Each system prompt section has one effective-text preview. Opening its editor hides that
  preview and shows one editable text area for the section; no second default text area is
  shown.
- Restoring a customized system prompt requires explicit confirmation; declining performs no
  delete, while confirming removes only that section's override on the pinned host.
- The character count updates with the draft, counts Unicode grapheme clusters, and never
  blocks a save based on length.
- `identity-intro` shows the baseline selected by the active Output Style state; an override
  remains effective with an active style, and the editor cannot open until that state is
  resolved. `memory-guidance` retains the literal placeholder and runtime substitution remains
  covered by the existing prompt contract; only it shows variable guidance.
- Local edits use the local service; remote edits use the resolved remote service. A dirty
  draft cannot silently move to another host, be written to that other host, or be discarded
  without confirmation. Disconnected remote services cannot be used for writes.
- Save/restore affect newly started sessions only, and all new Settings copy exists in
  en-US, zh-CN, and uk-UA.
- UI/model/hook tests cover editing, diff, save, restore, host routing, host-switch confirm and
  decline, and remote-not-ready behavior. A desktop Settings interaction scenario covers the
  user-visible editor flow.

### Ownership and event order

The Settings section owns the selected section, draft, baseline, and dirty state. The target
host's `systemPromptService` owns persisted overrides. The page only observes dirty state to
guard navigation. Resolve the service for the pinned target before loading; on host change,
confirm discard before replacing that target; on save or restore, call the captured target's
service and reload only while that host remains selected.

```text
active workspace target
  → pin target while draft is dirty
  → resolve target host services
  → list sections → render effective text / editor
  → save: writeOverride → list sections
  → restore: deleteOverride → list sections
  → new CLI session reads files at startup
```
