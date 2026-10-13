# System prompt section overrides

Status: phase 1 (constants + runtime + storage + service). Settings UI is planned, not
implemented.

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

## Settings UI (phase 2, planned)

One "System Prompt" section: a card per editable key (default text, "Customized" badge,
override editor with diff, Restore default), plus a read-only preview of the computed
sections. Local host only in v1 (remote editing follows the output-styles remote wiring).
